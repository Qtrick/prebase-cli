import os
import sys
import time
import subprocess
import requests
import re
from playwright.sync_api import sync_playwright

def mask_credentials(text: str) -> str:
    if not text:
        return text
    text = re.sub(r'bootstrap=[A-Za-z0-9_-]+', 'bootstrap=[REDACTED]', text)
    text = re.sub(r'prebase_session(?:_\d+)?=[A-Za-z0-9_-]+', 'prebase_session=[REDACTED]', text)
    return text

def sanitized_excepthook(exc_type, exc_value, exc_traceback):
    import traceback
    tb_str = "".join(traceback.format_exception(exc_type, exc_value, exc_traceback))
    sys.stderr.write(mask_credentials(tb_str))

sys.excepthook = sanitized_excepthook

def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    binary = os.path.join(repo_root, "target", "release", "prebase")
    port = 19999
    
    print(f"[2D SCREENSHOT] Launching PreBase on {repo_root} at port {port}...")
    proc = subprocess.Popen(
        [binary, "--port", str(port), "--no-open", "map", repo_root],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    
    try:
        # Wait for server ready
        bootstrap_url = None
        for _ in range(30):
            time.sleep(0.5)
            try:
                res = requests.get(f"http://127.0.0.1:{port}/api/health", timeout=1)
                if res.status_code == 200:
                    break
            except Exception:
                pass
        
        # Read bootstrap token or fetch from state
        # Server prints: Server running at: http://127.0.0.1:19999/?bootstrap=...
        # Let's inspect stdout without blocking
        import select
        r, _, _ = select.select([proc.stdout], [], [], 2.0)
        lines = []
        if r:
            lines = [proc.stdout.readline() for _ in range(10)]
        for line in lines:
            if "bootstrap=" in line:
                for token in line.split():
                    if "http://" in token and "bootstrap=" in token:
                        bootstrap_url = token.strip()
                        break
        
        import urllib.parse
        encoded_focus = urllib.parse.quote("crates/prebase-parser/src/tsconfig.rs", safe="")
        
        # Strip any ANSI escape sequences from bootstrap_url
        import re
        ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
        
        clean_token = None
        for line in lines:
            cleaned = ansi_escape.sub('', line)
            if "bootstrap=" in cleaned:
                for token in cleaned.split():
                    if "bootstrap=" in token:
                        m = re.search(r'bootstrap=([a-zA-Z0-9_-]+)', token)
                        if m:
                            clean_token = m.group(1)
                            break
                if clean_token:
                    break

        if clean_token:
            nav_url = f"http://127.0.0.1:{port}/?bootstrap={clean_token}&view=2d&focus={encoded_focus}"
        else:
            nav_url = f"http://127.0.0.1:{port}/?view=2d&focus={encoded_focus}"

        print(f"[2D SCREENSHOT] Navigating to: {nav_url}")
        
        os.makedirs(os.path.join(repo_root, "docs", "screenshots"), exist_ok=True)
        screenshot_path = os.path.join(repo_root, "docs", "screenshots", "14_2d_tsconfig_text_containment.png")
        
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1400, "height": 900})
            page.goto(nav_url, wait_until="networkidle")
            page.wait_for_selector(".relationship-canvas", state="visible", timeout=15000)
            
            # Wait for layout debug to be populated
            for _ in range(20):
                dbg = page.evaluate("() => window.__prebaseRelationshipDebug")
                if dbg and dbg.get("renderedNodeCount", 0) > 0:
                    break
                time.sleep(0.3)
            
            time.sleep(1.0)
            page.screenshot(path=screenshot_path)
            print(f"[PASS] Screenshot saved to: {screenshot_path}")
            
            dbg = page.evaluate("() => window.__prebaseRelationshipDebug")
            print(f"[2D SCREENSHOT] Debug state: {dbg['renderedNodeCount']} nodes rendered in 2D layout.")
            browser.close()
            
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        print("[2D SCREENSHOT] Server stopped cleanly.")

if __name__ == "__main__":
    main()
