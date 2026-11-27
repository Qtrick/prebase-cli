use axum::{
    body::Body,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "dist/"]
pub struct FrontendAssets;

/// Returns true if the frontend entrypoint (`index.html`) is available.
pub fn has_frontend_assets() -> bool {
    is_safe_asset_path("index.html") && FrontendAssets::get("index.html").is_some()
}

/// In debug builds (`rust-embed` reads from `CARGO_MANIFEST_DIR/dist`), verify that
/// the resolved file is not a symlink escaping the trusted `dist/` directory.
#[cfg(debug_assertions)]
fn is_safe_asset_path(asset_path: &str) -> bool {
    let dist_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("dist");
    let Ok(canonical_root) = std::fs::canonicalize(&dist_root) else {
        return false;
    };
    let candidate = dist_root.join(asset_path);
    let Ok(meta) = std::fs::symlink_metadata(&candidate) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return false;
    }
    let Ok(canonical_candidate) = std::fs::canonicalize(&candidate) else {
        return false;
    };
    canonical_candidate.starts_with(&canonical_root)
}

#[cfg(not(debug_assertions))]
fn is_safe_asset_path(_asset_path: &str) -> bool {
    true
}

/// Returns true if the path contains a file extension typical of static frontend assets.
fn is_static_asset_path(path: &str) -> bool {
    let p = std::path::Path::new(path);
    if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_ascii_lowercase();
        matches!(
            ext_lower.as_str(),
            "js" | "mjs"
                | "cjs"
                | "css"
                | "map"
                | "json"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "svg"
                | "ico"
                | "webp"
                | "avif"
                | "woff"
                | "woff2"
                | "ttf"
                | "eot"
                | "wasm"
                | "txt"
                | "xml"
                | "webmanifest"
        ) || mime_guess::from_path(path).first().is_some()
    } else {
        false
    }
}

pub async fn serve_static_asset(path: &str) -> Response {
    let clean_path = path.trim_start_matches('/');

    // 1. Path traversal and malformed path rejection
    if clean_path.contains("..") || clean_path.contains('\0') {
        return StatusCode::BAD_REQUEST.into_response();
    }

    // 2. API routes should never fall back to static assets or index.html
    if clean_path.starts_with("api/") || clean_path == "api" {
        return StatusCode::NOT_FOUND.into_response();
    }

    // 2. Direct match in embedded assets
    let asset_path = if clean_path.is_empty() {
        "index.html"
    } else {
        clean_path
    };

    if is_safe_asset_path(asset_path) {
        if let Some(file) = FrontendAssets::get(asset_path) {
            let mime = if asset_path == "index.html" {
                mime_guess::mime::TEXT_HTML_UTF_8
            } else {
                mime_guess::from_path(asset_path).first_or_octet_stream()
            };
            return Response::builder()
                .status(StatusCode::OK)
                .header(
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(mime.as_ref())
                        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
                )
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from(file.data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    }

    // 3. If a static asset with a file extension was requested but not found, return 404 NOT FOUND
    // rather than returning index.html with the wrong MIME type!
    if is_static_asset_path(clean_path) {
        return StatusCode::NOT_FOUND.into_response();
    }

    // 4. SPA fallback: Document navigation routes (paths without file extensions)
    // fall back to index.html with explicit text/html MIME type.
    if is_safe_asset_path("index.html") {
        if let Some(index_file) = FrontendAssets::get("index.html") {
            return Response::builder()
                .status(StatusCode::OK)
                .header(
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/html; charset=utf-8"),
                )
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from(index_file.data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
        }
    }
    StatusCode::NOT_FOUND.into_response()
}
