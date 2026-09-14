#!/usr/bin/env python3
"""Build a local, ad-hoc signed Apple Silicon DMG; never upload anything."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, cwd=ROOT, **kwargs)


def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("This release workflow currently supports Apple Silicon Macs only.")
    config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())
    version = config["version"]
    name = config["productName"]
    filename = f"Trellis-Viewer_{version}_aarch64.dmg"
    output = ROOT / "release" / version
    output.mkdir(parents=True, exist_ok=True)
    destination = output / filename
    if destination.exists():
        raise SystemExit(f"Release already exists: {destination}. Move it aside before rebuilding.")
    env = {**os.environ, "CI": "true"}
    cargo_bin = Path.home() / ".cargo/bin"
    env["PATH"] = str(cargo_bin) + os.pathsep + env.get("PATH", "")
    # Build the application first so notices and the final signature precede DMG creation.
    run("pnpm", "tauri", "build", "--ci", "--bundles", "app", env=env)
    built = ROOT / "src-tauri/target/release/bundle/macos" / f"{name}.app"
    with tempfile.TemporaryDirectory(prefix="trellis-viewer-release-") as temporary:
        stage = Path(temporary) / "image"
        stage.mkdir()
        app = stage / built.name
        run("ditto", str(built), str(app))
        binaries = app / "Contents/MacOS"
        # Tauri can collect previously built developer CLI targets. They aren't app features.
        for auxiliary in ("export-contracts", "index-bench"):
            (binaries / auxiliary).unlink(missing_ok=True)
        if sorted(p.name for p in binaries.iterdir()) != ["trellis-viewer"]:
            raise SystemExit("Unexpected executable in app bundle; inspect it before releasing.")
        resources = app / "Contents/Resources"
        resources.mkdir(exist_ok=True)
        for source in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            shutil.copy2(ROOT / source, resources / source)
        run("codesign", "--force", "--sign", "-", str(app))
        run("codesign", "--verify", "--deep", "--strict", str(app))
        architectures = run("lipo", "-archs", str(binaries / "trellis-viewer"), capture_output=True, text=True).stdout.strip()
        if architectures != "arm64":
            raise SystemExit(f"Unexpected architecture: {architectures}")
        (stage / "Applications").symlink_to("/Applications", target_is_directory=True)
        image = Path(temporary) / filename
        # No Finder automation, security overrides, or Apple developer credentials required.
        run("hdiutil", "create", "-volname", name, "-srcfolder", str(stage), "-format", "UDZO", "-fs", "HFS+", str(image))
        run("hdiutil", "verify", str(image))
        shutil.copy2(image, destination)
    checksum = hashlib.sha256()
    with destination.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    digest = checksum.hexdigest()
    (output / "SHA256SUMS.txt").write_text(f"{digest}  {filename}\n")
    print(f"\nDMG: {destination}\nSHA-256: {digest}\nSigning: ad-hoc; NOT Apple notarized.")


if __name__ == "__main__":
    main()
