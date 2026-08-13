use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
    routing::{get, put},
    Router,
};
use tokio::fs;
use tokio::io::AsyncWriteExt;

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

async fn put_bundle(State(state): State<AppState>, Path(token): Path<String>, headers: HeaderMap, body: Bytes) -> impl IntoResponse {
    let Some(token) = sanitize(&token) else { return (StatusCode::BAD_REQUEST, "bad token").into_response(); };
    if body.len() > state.max_bytes { return (StatusCode::PAYLOAD_TOO_LARGE, "too large").into_response(); }
    let (idx, total) = match part_info(&headers) {
        Ok(v) => v,
        Err(s) => return (s, "bad part headers").into_response(),
    };
    if total == 1 {
        let path = state.dir.join(&token);
        return match fs::write(&path, &body).await {
            Ok(_) => (StatusCode::OK, "ok").into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("write: {e}")).into_response(),
        };
    }
    let part_path = state.dir.join(format!("{token}.part{idx}"));
    if let Err(e) = fs::write(&part_path, &body).await {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("write: {e}")).into_response();
    }
    if idx + 1 == total {
        if let Err(e) = assemble(&state.dir, &token, total).await {
            return (StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
        }
    }
    (StatusCode::OK, "ok").into_response()
}

fn part_info(headers: &HeaderMap) -> Result<(usize, usize), StatusCode> {
    fn parse(headers: &HeaderMap, name: &str, def: usize) -> Result<usize, StatusCode> {
        match headers.get(name) {
            None => Ok(def),
            Some(v) => v.to_str().ok().and_then(|s| s.parse().ok()).ok_or(StatusCode::BAD_REQUEST),
        }
    }
    let idx = parse(headers, "x-part-index", 0)?;
    let total = parse(headers, "x-total-parts", 1)?;
    if total < 1 || idx >= total { return Err(StatusCode::BAD_REQUEST); }
    Ok((idx, total))
}

async fn assemble(dir: &std::path::Path, token: &str, total: usize) -> Result<(), String> {
    let mut out = fs::File::create(dir.join(token)).await.map_err(|e| format!("create: {e}"))?;
    for i in 0..total {
        let data = fs::read(dir.join(format!("{token}.part{i}"))).await.map_err(|_| "missing part".to_string())?;
        out.write_all(&data).await.map_err(|e| format!("write: {e}"))?;
    }
    for i in 0..total {
        let _ = fs::remove_file(dir.join(format!("{token}.part{i}"))).await;
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_info_parses_and_validates() {
        assert_eq!(part_info(&HeaderMap::new()).unwrap(), (0, 1));
        let mut h = HeaderMap::new();
        h.insert("x-part-index", "2".parse().unwrap());
        h.insert("x-total-parts", "3".parse().unwrap());
        assert_eq!(part_info(&h).unwrap(), (2, 3));
        h.insert("x-part-index", "9".parse().unwrap());
        assert_eq!(part_info(&h).unwrap_err(), StatusCode::BAD_REQUEST);
        h.insert("x-part-index", "x".parse().unwrap());
        assert_eq!(part_info(&h).unwrap_err(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn assemble_concats_and_cleans_parts() {
        let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("pandora-relay-asm-{stamp}"));
        fs::create_dir_all(&dir).await.unwrap();
        for (i, d) in ["aa", "bbb", "c"].iter().enumerate() {
            fs::write(dir.join(format!("tok.part{i}")), d).await.unwrap();
        }
        assemble(&dir, "tok", 3).await.unwrap();
        assert_eq!(fs::read_to_string(dir.join("tok")).await.unwrap(), "aabbbc");
        for i in 0..3 {
            assert!(!fs::try_exists(dir.join(format!("tok.part{i}"))).await.unwrap());
        }
        fs::remove_dir_all(&dir).await.unwrap();
    }
}
