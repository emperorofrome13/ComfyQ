from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from email.message import Message
from pathlib import PurePath
from typing import Any
from urllib.parse import unquote, urlparse

import aiohttp
from aiohttp import web

import folder_paths
from server import PromptServer


DOWNLOADS: dict[str, "DownloadJob"] = {}
EXTRA_MODEL_EXTENSIONS = {
    ".gguf",
    ".onnx",
    ".json",
    ".yaml",
    ".yml",
    ".txt",
}


@dataclass
class DownloadJob:
    id: str
    url: str
    folder: str
    destination: str
    status: str = "queued"
    bytes_downloaded: int = 0
    total_bytes: int | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    error: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "url": self.url,
            "folder": self.folder,
            "destination": self.destination,
            "filename": os.path.basename(self.destination),
            "status": self.status,
            "bytes_downloaded": self.bytes_downloaded,
            "total_bytes": self.total_bytes,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
        }


def _json_error(message: str, status: int = 400) -> web.Response:
    return web.json_response({"error": message}, status=status)


def _normal_folder_name(folder: str) -> str:
    if not isinstance(folder, str) or not folder:
        raise ValueError("folder is required")
    mapped = folder_paths.map_legacy(folder)
    if mapped not in folder_paths.folder_names_and_paths:
        raise ValueError(f"Unknown model folder: {folder}")
    return mapped


def _safe_subpath(value: str | None) -> str:
    if not value:
        return ""
    normalized = value.replace("\\", "/").strip("/")
    path = PurePath(normalized)
    if path.is_absolute() or any(part in {"..", ""} for part in path.parts):
        raise ValueError("Subfolders cannot be absolute or contain '..'")
    return os.path.join(*path.parts) if path.parts else ""


def _safe_filename(value: str) -> str:
    name = os.path.basename(value.replace("\\", "/")).strip()
    if not name or name in {".", ".."}:
        raise ValueError("A filename could not be determined")
    if any(ch in name for ch in '<>:"|?*\0'):
        raise ValueError(f"Invalid filename: {name}")
    return name


def _filename_from_headers_or_url(headers: Message | aiohttp.typedefs.LooseHeaders, url: str) -> str:
    disposition = headers.get("Content-Disposition") if headers else None
    if disposition:
        match = re.search(r"filename\*=UTF-8''([^;]+)|filename=\"?([^\";]+)\"?", disposition)
        if match:
            return _safe_filename(unquote(match.group(1) or match.group(2)))

    parsed = urlparse(url)
    return _safe_filename(unquote(os.path.basename(parsed.path)))


def _allowed_extensions(folder: str) -> set[str]:
    exts = folder_paths.folder_names_and_paths[folder][1]
    if isinstance(exts, set):
        return {x.lower() for x in exts if x and x != "folder"} | EXTRA_MODEL_EXTENSIONS
    return {str(x).lower() for x in exts if x and x != "folder"} | EXTRA_MODEL_EXTENSIONS


def _validate_download_extension(folder: str, filename: str) -> None:
    ext = os.path.splitext(filename)[1].lower()
    allowed = _allowed_extensions(folder)
    if allowed and ext not in allowed:
        raise ValueError(
            f"{filename} does not look like a supported model file for '{folder}'. "
            f"Allowed extensions include: {', '.join(sorted(allowed))}"
        )


def _folder_root(folder: str, path_index: int = 0) -> str:
    folder = _normal_folder_name(folder)
    roots = folder_paths.folder_names_and_paths[folder][0]
    if path_index < 0 or path_index >= len(roots):
        raise ValueError(f"path_index {path_index} is out of range for {folder}")
    return os.path.abspath(roots[path_index])


def _resolve_target_dir(folder: str, path_index: int = 0, subfolder: str | None = None) -> str:
    root = _folder_root(folder, path_index)
    target = os.path.abspath(os.path.join(root, _safe_subpath(subfolder)))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("Resolved target folder escapes the model root")
    return target


def _resolve_model_path(folder: str, path_index: int = 0, filename: str | None = None) -> str:
    root = _folder_root(folder, path_index)
    if not filename:
        return root
    existing = folder_paths.get_full_path(_normal_folder_name(folder), filename)
    if existing and os.path.isfile(existing):
        return os.path.dirname(os.path.abspath(existing))
    relative = _safe_subpath(filename)
    target = os.path.abspath(os.path.join(root, relative))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("Resolved model path escapes the model root")
    ext = os.path.splitext(target)[1].lower()
    model_exts = _allowed_extensions(folder)
    if os.path.isfile(target) or ext in model_exts:
        return os.path.dirname(target)
    return target if os.path.isdir(target) else root


def _open_folder(path: str) -> None:
    os.makedirs(path, exist_ok=True)
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def _clear_model_caches(folder: str) -> None:
    folder_paths.filename_list_cache.pop(folder, None)
    instance = getattr(PromptServer, "instance", None)
    manager = getattr(instance, "model_file_manager", None)
    if manager is not None:
        manager.clear_cache()


def _model_folders_payload() -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for name, (folders, extensions) in folder_paths.folder_names_and_paths.items():
        if name in {"configs", "custom_nodes"}:
            continue
        output.append(
            {
                "name": name,
                "folders": [os.path.abspath(path) for path in folders],
                "extensions": sorted([str(ext) for ext in extensions]),
            }
        )
    return output


async def _download(job: DownloadJob, expected_sha256: str | None, overwrite: bool) -> None:
    temp_path = job.destination + ".part"
    job.status = "downloading"
    hasher = hashlib.sha256() if expected_sha256 else None
    try:
        os.makedirs(os.path.dirname(job.destination), exist_ok=True)
        if os.path.exists(job.destination) and not overwrite:
            raise FileExistsError(f"{job.destination} already exists")
        if os.path.exists(temp_path):
            os.remove(temp_path)

        timeout = aiohttp.ClientTimeout(total=None, sock_connect=45, sock_read=120)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(job.url, allow_redirects=True) as response:
                response.raise_for_status()
                # aiohttp decompresses HTTP content; its wire length then differs from saved bytes.
                job.total_bytes = response.content_length if response.headers.get("Content-Encoding", "identity").lower() == "identity" else None
                with open(temp_path, "wb") as output:
                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        if not chunk:
                            continue
                        output.write(chunk)
                        job.bytes_downloaded += len(chunk)
                        if hasher is not None:
                            hasher.update(chunk)

        if hasher is not None:
            digest = hasher.hexdigest().lower()
            if digest != expected_sha256.lower():
                raise ValueError(f"SHA256 mismatch: expected {expected_sha256}, got {digest}")

        if overwrite and os.path.exists(job.destination):
            os.remove(job.destination)
        shutil.move(temp_path, job.destination)
        job.status = "complete"
        _clear_model_caches(job.folder)
    except Exception as exc:
        job.status = "error"
        job.error = str(exc)
        try:
            if os.path.exists(temp_path):
                os.remove(temp_path)
        except OSError:
            pass
        logging.exception("[comfyQ] Model download failed")
    finally:
        job.finished_at = time.time()


def register_routes() -> None:
    routes = PromptServer.instance.routes

    @routes.get("/comfyq/info")
    async def info(request: web.Request) -> web.Response:
        return web.json_response(
            {
                "version": "1.02",
                "process_id": os.getpid(),
                "model_folders": _model_folders_payload(),
                "paths": {
                    "input": folder_paths.get_input_directory(),
                    "output": folder_paths.get_output_directory(),
                    "temp": folder_paths.get_temp_directory(),
                    "custom_nodes": folder_paths.get_folder_paths("custom_nodes"),
                },
                "suggestions": [
                    "Open input, output, custom nodes, and model folders from the UI.",
                    "Download missing models to the selected ComfyUI model directory.",
                    "Unpack or remove all current-workflow subgraphs.",
                    "Copy selected model names and rescan model lists after downloads.",
                ],
            }
        )

    @routes.post("/comfyq/open-folder")
    async def open_folder(request: web.Request) -> web.Response:
        try:
            data = await request.json()
            special = data.get("special")
            if special == "input":
                path = folder_paths.get_input_directory()
            elif special == "output":
                path = folder_paths.get_output_directory()
            elif special == "temp":
                path = folder_paths.get_temp_directory()
            elif special == "custom_nodes":
                path = folder_paths.get_folder_paths("custom_nodes")[0]
            else:
                path = _resolve_model_path(
                    data.get("folder"),
                    int(data.get("path_index", 0)),
                    data.get("filename"),
                )
            _open_folder(path)
            return web.json_response({"ok": True, "path": path})
        except Exception as exc:
            return _json_error(str(exc))

    @routes.get("/comfyq/downloads")
    async def list_downloads(request: web.Request) -> web.Response:
        return web.json_response([job.to_json() for job in DOWNLOADS.values()])

    @routes.get("/comfyq/downloads/{job_id}")
    async def get_download(request: web.Request) -> web.Response:
        job = DOWNLOADS.get(request.match_info["job_id"])
        if job is None:
            return _json_error("Unknown download id", status=404)
        return web.json_response(job.to_json())

    @routes.post("/comfyq/download")
    async def start_download(request: web.Request) -> web.Response:
        try:
            data = await request.json()
            url = str(data.get("url", "")).strip()
            parsed = urlparse(url)
            if parsed.scheme not in {"http", "https"}:
                raise ValueError("Download URL must start with http:// or https://")

            folder = _normal_folder_name(data.get("folder"))
            path_index = int(data.get("path_index", 0))
            target_dir = _resolve_target_dir(folder, path_index, data.get("subfolder"))
            filename = data.get("filename")
            if filename:
                filename = _safe_filename(filename)
            else:
                filename = _filename_from_headers_or_url({}, url)
            _validate_download_extension(folder, filename)

            destination = os.path.abspath(os.path.join(target_dir, filename))
            if os.path.commonpath([target_dir, destination]) != target_dir:
                raise ValueError("Resolved destination escapes target folder")

            job_id = uuid.uuid4().hex
            job = DownloadJob(job_id, url, folder, destination)
            DOWNLOADS[job_id] = job
            task = asyncio.create_task(
                _download(
                    job,
                    data.get("sha256") or None,
                    bool(data.get("overwrite", False)),
                )
            )
            task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
            return web.json_response(job.to_json())
        except Exception as exc:
            return _json_error(str(exc))
