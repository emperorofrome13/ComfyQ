from __future__ import annotations

import argparse
import os
import shutil
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Install comfyQ into another ComfyUI custom_nodes folder.")
    parser.add_argument("comfyui_root", help="Path to a ComfyUI folder or ComfyUI_windows_portable folder.")
    parser.add_argument("--replace", action="store_true", help="Replace an existing comfyQ installation.")
    args = parser.parse_args()

    source = Path(__file__).resolve().parents[1]
    root = Path(args.comfyui_root).resolve()
    comfy_root = root / "ComfyUI" if (root / "ComfyUI").is_dir() else root
    custom_nodes = comfy_root / "custom_nodes"
    if not custom_nodes.is_dir():
        raise SystemExit(f"Could not find custom_nodes under {root}")

    destination = custom_nodes / "comfyQ"
    if destination.exists():
        if not args.replace:
            raise SystemExit(f"{destination} already exists. Pass --replace to overwrite it.")
        shutil.rmtree(destination)

    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".git")
    shutil.copytree(source, destination, ignore=ignore)
    print(f"Installed comfyQ to {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
