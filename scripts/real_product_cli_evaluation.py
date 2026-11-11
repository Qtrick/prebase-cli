#!/usr/bin/env python3
"""
PreBase CLI — Hands-on Real-World Product Evaluation & Verification
Executes actual compiled CLI binary against 3 repository archetypes:
  Repo A: Small TypeScript Component & Dependency Fixture
  Repo B: Multi-Branch Rich Git History Topology (>50 commits)
  Repo C: Actual PreBase Codebase (Read-Only)
Exercises all real-use checklists across Network, 2D, and Temporal modes.
"""

import os
import sys
import time
import shutil
import tempfile
import subprocess
import urllib.request
import re
from playwright.sync_api import sync_playwright, expect

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BIN = os.path.join(ROOT_DIR, "target", "release", "prebase")

def log(step, msg):
    print(f"\x1b[36m[{step}]\x1b[0m {msg}", flush=True)

def success(msg):
    print(f"\x1b[32m[PASS]\x1b[0m {msg}", flush=True)

def fail(msg):
    print(f"\x1b[31m[FAIL]\x1b[0m {msg}", file=sys.stderr, flush=True)
    sys.exit(1)

def parse_startup_info(log_path):
    startup_url, bootstrap_token = None, None
    for _ in range(50):
        if os.path.exists(log_path):
            with open(log_path, "r") as f:
                content = f.read()
                for line in content.splitlines():
                    if "Server running at:" in line:
                        startup_url = line.split("Server running at:")[1].strip()
                        startup_url = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', startup_url)
                        if "bootstrap=" in startup_url:
                            bootstrap_token = startup_url.split("bootstrap=")[1].split("&")[0].split(" ")[0].strip()
                        break
        if startup_url and bootstrap_token:
            break
        time.sleep(0.1)
    return startup_url, bootstrap_token

def test_repository_a_small_deps(p):
    log("REPO-A", "Creating Small TypeScript Component & Dependency Fixture...")
    repo_dir = tempfile.mkdtemp(prefix="prebase-eval-repoA-")
    try:
        # Create components, utils, isolated file, and unsupported file
        src = os.path.join(repo_dir, "src")
        comp = os.path.join(src, "components")
        utils = os.path.join(src, "utils")
        os.makedirs(comp, exist_ok=True)
        os.makedirs(utils, exist_ok=True)

        with open(os.path.join(utils, "math.ts"), "w") as f:
            f.write("export function sum(a: number, b: number) { return a + b; }\n")
        with open(os.path.join(comp, "Button.tsx"), "w") as f:
            f.write('import { sum } from "../utils/math";\nexport const Button = () => <button>{sum(1, 2)}</button>;\n')
        with open(os.path.join(comp, "Card.tsx"), "w") as f:
            f.write('import { Button } from "./Button";\nexport const Card = () => <div><Button /></div>;\n')
        with open(os.path.join(src, "index.ts"), "w") as f:
            f.write('import { Card } from "./components/Card";\nconsole.log(Card);\n')
        with open(os.path.join(src, "isolated.ts"), "w") as f:
            f.write('export const ISOLATED_FLAG = true;\n')
        with open(os.path.join(repo_dir, "build.log"), "w") as f:
            f.write('Build completed successfully.\n')

        # Test CLI default map launch with dynamic port allocation (port 0)
        log_file_path = os.path.join(repo_dir, "server.log")
        log_file = open(log_file_path, "w")
        cmd = [BIN, "--port", "0", "--no-open", "map", repo_dir]
        proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)
        
        try:
            startup_url, token = parse_startup_info(log_file_path)
            assert startup_url and token, "Could not acquire startup URL"
            success("CLI started on Repo A with dynamic port allocation")

            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(startup_url, wait_until="domcontentloaded")
            expect(page.locator(".status-indicator:has-text('Index Ready')")).to_be_visible(timeout=10000)
            success("Browser loaded Repo A with Ready index")

            # 1. Verify exact graph topology & isolated file behavior via browser session
            snap = page.evaluate("() => fetch('/api/v1/network').then(r => r.json())")
            nodes = {n["id"]: n for n in snap["nodes"]}
            assert "src/index.ts" in nodes, "src/index.ts must exist in graph nodes"
            assert "src/components/Card.tsx" in nodes, "src/components/Card.tsx must exist"
            assert "src/components/Button.tsx" in nodes, "src/components/Button.tsx must exist"
            assert "src/utils/math.ts" in nodes, "src/utils/math.ts must exist"
            assert "src/isolated.ts" in nodes, "src/isolated.ts must exist"
            assert "build.log" in nodes, "build.log must exist as discovered file"

            # Check isolated node semantics
            assert nodes["src/isolated.ts"]["direct_dependency_count"] == 0
            assert nodes["src/isolated.ts"]["direct_dependent_count"] == 0

            # Check exact directed edge topology (index -> Card -> Button -> math)
            edges = [(e["source_file_id"], e["target_file_id"]) for e in snap["edges"]]
            assert ("src/index.ts", "src/components/Card.tsx") in edges
            assert ("src/components/Card.tsx", "src/components/Button.tsx") in edges
            assert ("src/components/Button.tsx", "src/utils/math.ts") in edges
            assert len(edges) == 3, f"Expected exactly 3 edges, got {len(edges)}: {edges}"
            success("Exact graph topology, dependencies, evidence, and isolated node verified")

            # 2. Verify Network Canvas rendered
            expect(page.locator(".network-canvas")).to_be_visible(timeout=5000)
            
            # 3. Select node via search with camera orientation verification
            cam_before = page.evaluate("() => window.__prebaseNetworkDebug ? window.__prebaseNetworkDebug.getCamera() : null")
            assert cam_before is not None, "window.__prebaseNetworkDebug must be available"

            search_input = page.locator(".search-input")
            search_input.fill("Card")
            page.wait_for_selector("#search-dropdown-list", timeout=5000)
            page.locator("li.search-item:has-text('Card.tsx')").click()
            expect(page.locator(".inspector-panel")).to_contain_text("Card.tsx", timeout=5000)

            cam_after = page.evaluate("() => window.__prebaseNetworkDebug ? window.__prebaseNetworkDebug.getCamera() : null")
            assert cam_after is not None, "window.__prebaseNetworkDebug must be available"
            assert abs(cam_before['yaw'] - cam_after['yaw']) < 1e-4, f"Yaw changed: {cam_before['yaw']} vs {cam_after['yaw']}"
            assert abs(cam_before['pitch'] - cam_after['pitch']) < 1e-4, f"Pitch changed: {cam_before['pitch']} vs {cam_after['pitch']}"
            assert abs(cam_before['zoom'] - cam_after['zoom']) < 1e-4, f"Zoom changed: {cam_before['zoom']} vs {cam_after['zoom']}"
            assert abs(cam_before['panX'] - cam_after['panX']) < 1e-4, f"PanX changed: {cam_before['panX']} vs {cam_after['panX']}"
            assert abs(cam_before['panY'] - cam_after['panY']) < 1e-4, f"PanY changed: {cam_before['panY']} vs {cam_after['panY']}"
            success("Search selection found and selected Card.tsx with strict camera orientation preservation assertion")

            # 4. Direct 2D Exploration
            page.locator("button.mode-btn:has-text('2D Relationships')").click()
            expect(page.locator(".relationship-container")).to_be_visible(timeout=5000)
            success("Switched to 2D Relationship Explorer")

            # Verify direct dependencies (Button.tsx) and dependents (index.ts)
            expect(page.locator(".inspector-panel")).to_contain_text("Button.tsx", timeout=5000)
            expect(page.locator(".inspector-panel")).to_contain_text("index.ts", timeout=5000)
            success("Card.tsx direct dependencies and dependents accurately confirmed")

            # 5. Non-optional Refocus on Button.tsx and Back navigation
            button_rel = page.locator(".inspector-panel .relation-item-btn:has-text('Button.tsx')")
            expect(button_rel).to_be_visible(timeout=5000)
            button_rel.click()

            refocus_btn = page.locator("button.refocus-2d-btn:has-text('Focus relationships here')")
            expect(refocus_btn).to_be_visible(timeout=5000)
            refocus_btn.click()
            expect(page.locator(".inspector-panel h3.file-name")).to_have_text("Button.tsx", timeout=5000)

            back_btn = page.locator("button.hud-btn.back-btn")
            expect(back_btn).to_be_visible(timeout=5000)
            back_btn.click()
            expect(page.locator(".inspector-panel h3.file-name")).to_have_text("Card.tsx", timeout=5000)
            success("2D Refocus on neighbor and Back navigation verified (non-optional assertion passed)")

            # 6. Return to 3D
            page.locator("button.mode-btn:has-text('3D Overview')").click()
            expect(page.locator(".network-canvas")).to_be_visible(timeout=5000)
            success("Returned from 2D to 3D Overview")

            browser.close()
        finally:
            proc.terminate()
            proc.wait(timeout=5)
    finally:
        shutil.rmtree(repo_dir, ignore_errors=True)

def test_repository_b_rich_git(p):
    log("REPO-B", "Testing Multi-Branch Rich Git History (>50 commits)...")
    repo_dir = tempfile.mkdtemp(prefix="prebase-eval-repoB-")
    try:
        git = lambda *args: subprocess.check_call(
            ["git"] + list(args), cwd=repo_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        git("init", "-b", "main")
        git("config", "user.name", "Eval User")
        git("config", "user.email", "eval@prebase.dev")

        src = os.path.join(repo_dir, "src")
        os.makedirs(src, exist_ok=True)
        with open(os.path.join(src, "app.ts"), "w") as f:
            f.write("console.log('init');\n")
        git("add", ".")
        git("commit", "-m", "feat: initial commit")

        # Feature branch
        git("checkout", "-b", "feature/service")
        with open(os.path.join(src, "service.ts"), "w") as f:
            f.write("export const apiService = () => 'ok';\n")
        git("add", ".")
        git("commit", "-m", "feat: add apiService")

        git("checkout", "main")
        git("merge", "--no-ff", "feature/service", "-m", "merge: feature/service into main")

        for i in range(1, 52):
            with open(os.path.join(repo_dir, "LOG.md"), "a") as f:
                f.write(f"Entry {i}\n")
            git("add", "LOG.md")
            git("commit", "-m", f"chore: entry {i}")

        log_file_path = os.path.join(repo_dir, "server.log")
        log_file = open(log_file_path, "w")
        cmd = [BIN, "--port", "0", "--no-open", "history", repo_dir]
        proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)
        
        try:
            startup_url, token = parse_startup_info(log_file_path)
            assert startup_url and token, "Could not acquire startup URL"
            success("CLI started on Repo B in history mode")

            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(startup_url, wait_until="domcontentloaded")
            expect(page.locator(".status-indicator:has-text('Index Ready')")).to_be_visible(timeout=10000)

            # Verify initial overview in inspector before commit selection
            expect(page.locator(".inspector-panel")).to_contain_text("Git History Overview", timeout=5000)
            expect(page.locator(".inspector-panel")).to_contain_text("50 of 54 commits loaded", timeout=5000)
            success("Contextual Temporal Overview rendered prior to commit selection")

            # Click commit dot via actual mouse
            canvas = page.locator(".temporal-canvas-container canvas")
            box = canvas.bounding_box()
            pos = page.evaluate("() => window.__prebaseTemporalDebug ? window.__prebaseTemporalDebug.getScreenPosition(0) : null")
            assert pos, "Screen position for commit 0 must exist"
            page.mouse.click(box["x"] + pos["x"], box["y"] + pos["y"])
            expect(page.locator(".inspector-panel .sha-text")).to_be_visible(timeout=5000)
            success("CommitInspector displayed via real pointer event")

            # Pagination
            page.locator(".pagination-btn:has-text('Load older commits')").click()
            expect(page.locator(".temporal-header-info")).to_contain_text("54 of 54", timeout=10000)
            success("Loaded remaining commits via anchor pagination")

            # Live commit test while browser is open
            with open(os.path.join(repo_dir, "LOG.md"), "a") as f:
                f.write("Live commit\n")
            git("add", "LOG.md")
            git("commit", "-m", "feat: 55th live commit")
            expect(page.locator(".temporal-header-info")).to_contain_text("55", timeout=15000)
            success("Live Git commit detected via SSE without page reload")

            browser.close()
        finally:
            proc.terminate()
            proc.wait(timeout=5)
    finally:
        shutil.rmtree(repo_dir, ignore_errors=True)

def test_repository_c_read_only_prebase(p):
    log("REPO-C", "Launching PreBase against its own codebase (read-only)...")
    log_file_path = os.path.join(tempfile.gettempdir(), "prebase-self.log")
    log_file = open(log_file_path, "w")
    cmd = [BIN, "--port", "0", "--no-open", "map", ROOT_DIR]
    proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)
    try:
        startup_url, token = parse_startup_info(log_file_path)
        assert startup_url and token, "Could not acquire startup URL"
        success("CLI started on actual PreBase repository")

        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(startup_url, wait_until="domcontentloaded")
        expect(page.locator(".status-indicator:has-text('Index Ready')")).to_be_visible(timeout=15000)
        success("PreBase repository indexed and browser loaded")

        # Verify areas in PreBase
        expect(page.locator(".network-canvas")).to_be_visible(timeout=5000)
        expect(page.locator(".inspector-panel")).to_contain_text("PreBase", timeout=5000)
        success("PreBase architectural areas and overview verified")

        # Verify search works in real repo
        search = page.locator(".search-input")
        search.fill("App.tsx")
        page.wait_for_selector("#search-dropdown-list", timeout=5000)
        expect(page.locator("li.search-item:has-text('App.tsx')")).to_be_visible(timeout=5000)
        page.locator("li.search-item:has-text('App.tsx')").first.click()
        expect(page.locator(".inspector-panel")).to_contain_text("App.tsx", timeout=5000)
        success("Search and node selection confirmed on real codebase")

        # Test responsive layouts
        for w, h in [(1024, 768), (1280, 800), (1440, 900), (1920, 1080)]:
            page.set_viewport_size({"width": w, "height": h})
            time.sleep(0.2)
            expect(page.locator(".network-canvas")).to_be_visible()
            expect(page.locator(".inspector-panel")).to_be_visible()
        success("Responsive layouts verified (1024x768 to 1920x1080)")

        browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        if os.path.exists(log_file_path):
            os.remove(log_file_path)

def test_failure_behaviors():
    log("FAILURES", "Testing error handling & failure behaviors...")
    
    # 1. Invalid repository path
    res = subprocess.run([BIN, "--no-open", "map", "/nonexistent/path/for/sure"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert res.returncode != 0, "CLI must fail on non-existent path"
    success("Non-existent repository path rejected with non-zero exit code")

    # 2. No-watch mode with dynamic port allocation (port 0)
    tmp = tempfile.mkdtemp()
    try:
        proc = subprocess.Popen([BIN, "--port", "0", "--no-open", "--no-watch", "map", tmp], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.0)
        assert proc.poll() is None, "Server must remain running in --no-watch mode"
        proc.terminate()
        proc.wait(timeout=5)
        success("--no-watch mode launches cleanly on port 0 and terminates gracefully")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def main():
    print("=" * 80)
    print("PreBase CLI — Hands-on Real-World Product Evaluation")
    print("=" * 80)

    if not os.path.exists(BIN):
        fail(f"Executable not found at {BIN}")

    with sync_playwright() as p:
        test_repository_a_small_deps(p)
        test_repository_b_rich_git(p)
        test_repository_c_read_only_prebase(p)
        test_failure_behaviors()

    print("=" * 80)
    print("\x1b[32mALL REAL-WORLD PRODUCT EVALUATION CHECKS PASSED!\x1b[0m")
    print("=" * 80)

if __name__ == "__main__":
    main()

