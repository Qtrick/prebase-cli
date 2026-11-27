use std::fs;
use std::path::Path;

fn visit_dist_dir(dir: &Path) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) => panic!("Failed to read {}: {err}", dir.display()),
    };
    for entry in entries {
        let entry = entry.expect("Failed to read dist directory entry");
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)
            .unwrap_or_else(|e| panic!("Failed to stat {}: {e}", path.display()));
        if meta.file_type().is_symlink() {
            panic!(
                "Refusing to embed symlink inside crates/prebase-server/dist: {}",
                path.display()
            );
        }
        if meta.is_dir() {
            visit_dist_dir(&path);
        } else {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    // In release builds, track dist/ recursively so updated/added/removed frontend
    // assets always invalidate and re-embed into prebase-server, and reject symlinks.
    // In debug/dev builds, rust-embed reads dist/ from disk at runtime, so we
    // intentionally do NOT watch dist/ to avoid recompiling Rust on frontend edits.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let dist_dir = Path::new("dist");
        let index_html = dist_dir.join("index.html");
        if !index_html.is_file() {
            panic!(
                "Release build requires frontend assets at crates/prebase-server/dist/index.html. Run ./scripts/build.sh or npm --prefix frontend run build first."
            );
        }
        visit_dist_dir(dist_dir);
    }
}
