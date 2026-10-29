use axum::{
    body::Body,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "dist/"]
pub struct FrontendAssets;

pub async fn serve_static_asset(path: &str) -> Response {
    let clean_path = path.trim_start_matches('/');
    let asset_path = if clean_path.is_empty() {
        "index.html"
    } else {
        clean_path
    };

    match FrontendAssets::get(asset_path).or_else(|| FrontendAssets::get("index.html")) {
        Some(file) => {
            let mime = mime_guess::from_path(asset_path).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(mime.as_ref())
                        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
                )
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from(file.data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
