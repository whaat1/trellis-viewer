#!/usr/bin/env python3
"""Build the Windows x64 installer and retain its dependency notices."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TARGET = "x86_64-pc-windows-msvc"


def run(*args, **kwargs):
    # Windows package-manager shims are .cmd files; use their resolved paths.
    executable = shutil.which(args[0]) or args[0]
    return subprocess.run([executable, *args[1:]], cwd=ROOT, check=True, **kwargs)


def prepare_notices():
    metadata = json.loads(run(
        "cargo", "metadata", "--locked", "--format-version", "1",
        "--manifest-path", "src-tauri/Cargo.toml", "--filter-platform", TARGET,
        capture_output=True, text=True, encoding="utf-8",
    ).stdout)
    resolved = {node["id"] for node in metadata["resolve"]["nodes"]}
    bundled_notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    sections = ["# Windows Rust dependency notices\n\n"
                "Generated from Cargo.lock for Windows x64. JavaScript notices "
                "are included in THIRD_PARTY_NOTICES.md.\n"]
    for package in sorted(metadata["packages"], key=lambda item: (item["name"], item["version"])):
        if package["id"] not in resolved or package["source"] is None:
            continue
        directory = Path(package["manifest_path"]).parent
        files = {path for path in directory.iterdir() if path.is_file()
                 and path.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE"))}
        if package.get("license_file"):
            files.add(directory / package["license_file"])
        if not files:
            identity = f"{package['name']} {package['version']}"
            if f"**{identity}**" not in bundled_notices:
                raise RuntimeError(f"Missing license text for {identity}")
            sections.append(f"\n## {identity}\n\nLicense and upstream attribution "
                            "are retained in the bundled THIRD_PARTY_NOTICES.md.\n")
            continue
        sections.append(f"\n## {package['name']} {package['version']}\n\n"
                        f"License: {package.get('license') or 'see license file'}\n")
        for path in sorted(files):
            sections.append(f"\n### {path.name}\n\n{path.read_text(encoding='utf-8')}\n")
    destination = ROOT / "src-tauri/target/THIRD_PARTY_NOTICES_WINDOWS.md"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(sections), encoding="utf-8")
    print(f"Windows notices: {destination}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Windows":
        raise SystemExit("Build this installer on Windows with the MSVC x64 toolchain.")
    version = json.loads((ROOT / "package.json").read_text())["version"]
    config_version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
    if version != config_version:
        raise SystemExit("package.json and Tauri versions differ")
    prepare_notices()
    if args.prepare_only:
        return
    output = ROOT / "release" / version
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"Trellis-Viewer_{version}_x64-setup.exe"
    if destination.exists():
        raise SystemExit(f"Release already exists: {destination}")
    run("pnpm", "tauri", "build", "--ci", "--bundles", "nsis", "--target", TARGET,
        env={**os.environ, "CI": "true"})
    installers = list((ROOT / f"src-tauri/target/{TARGET}/release/bundle/nsis").glob(f"*_{version}_x64-setup.exe"))
    if len(installers) != 1:
        raise SystemExit(f"Expected one installer, found {len(installers)}")
    shutil.copy2(installers[0], destination)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    (output / "SHA256SUMS-Windows.txt").write_text(f"{digest}  {destination.name}\n", encoding="utf-8")
    print(f"Installer: {destination}\nSHA-256: {digest}\nSigning: unsigned")


if __name__ == "__main__":
    main()
