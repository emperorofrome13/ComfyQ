import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const state = {
  info: null,
  panel: null,
  downloads: new Map(),
};

const MODEL_WIDGET_FOLDERS = {
  ckpt_name: "checkpoints",
  unet_name: "diffusion_models",
  vae_name: "vae",
  lora_name: "loras",
  control_net_name: "controlnet",
  controlnet_name: "controlnet",
  upscale_model_name: "upscale_models",
  clip_vision_name: "clip_vision",
  style_model_name: "style_models",
};

const FOLDER_ICON_SIZE = 18;
const FOLDER_ICON_MARGIN = 8;
const PANEL_POSITION_KEY = "comfyQ.panelPosition";
const LAUNCHER_POSITION_KEY = "comfyQ.launcherPosition";
const DRAG_THRESHOLD = 4;

function $(selector, root = document) {
  return root.querySelector(selector);
}

function setElementPosition(element, key, left, top, save = true) {
  const bounds = element.getBoundingClientRect();
  const maxLeft = Math.max(0, window.innerWidth - bounds.width);
  const maxTop = Math.max(0, window.innerHeight - bounds.height);
  const position = {
    left: Math.min(maxLeft, Math.max(0, left)),
    top: Math.min(maxTop, Math.max(0, top)),
  };
  element.style.left = `${position.left}px`;
  element.style.top = `${position.top}px`;
  element.style.right = "auto";
  element.style.bottom = "auto";
  if (save) {
    try { localStorage.setItem(key, JSON.stringify(position)); } catch {}
  }
}

function restoreElementPosition(element, key) {
  try {
    const position = JSON.parse(localStorage.getItem(key) || "null");
    if (Number.isFinite(position?.left) && Number.isFinite(position?.top)) {
      setElementPosition(element, key, position.left, position.top, false);
    }
  } catch {}
}

// Drag `element` by `handle` (pointer or arrow keys) and remember where it was left.
// A press that moves less than DRAG_THRESHOLD stays a normal click, so the launcher still opens the panel.
function makeMovable(element, handle, key) {
  handle.tabIndex = 0;
  handle.addEventListener("keydown", (event) => {
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    const bounds = element.getBoundingClientRect();
    const step = event.shiftKey ? 48 : 16;
    setElementPosition(
      element,
      key,
      bounds.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
      bounds.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
    );
  });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target !== handle && event.target.closest("button"))) return;
    const bounds = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;

    const onMove = (pointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      const dx = pointerEvent.clientX - startX;
      const dy = pointerEvent.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        handle.classList.add("dragging");
      }
      setElementPosition(element, key, bounds.left + dx, bounds.top + dy, false);
    };
    const onEnd = (pointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (!dragging) return;
      handle.classList.remove("dragging");
      const end = element.getBoundingClientRect();
      setElementPosition(element, key, end.left, end.top);
      // Swallow the click that follows a drag.
      handle.addEventListener("click", (click) => { click.stopImmediatePropagation(); click.preventDefault(); }, { capture: true, once: true });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  });
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "style") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, value);
    }
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child !== undefined && child !== null) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

async function comfyQFetch(path, options = {}) {
  const response = await api.fetchApi(path, options);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

function toast(message, isError = false) {
  if (app.ui?.dialog?.show) {
    app.ui.dialog.show(message);
  } else {
    console[isError ? "error" : "log"](`[comfyQ] ${message}`);
  }
}

async function loadInfo(force = false) {
  if (!state.info || force) state.info = await comfyQFetch("/comfyq/info");
  return state.info;
}

async function openFolder(payload) {
  const result = await comfyQFetch("/comfyq/open-folder", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  toast(`Opened: ${result.path}`);
}

function inferFolderFromNode(node) {
  const haystack = `${node?.type || ""} ${node?.title || ""} ${node?.constructor?.comfyClass || ""}`.toLowerCase();
  if (haystack.includes("lora")) return "loras";
  if (haystack.includes("vae")) return "vae";
  if (haystack.includes("control")) return "controlnet";
  if (haystack.includes("upscale")) return "upscale_models";
  if (haystack.includes("clip") || haystack.includes("text encoder")) return "text_encoders";
  if (haystack.includes("unet") || haystack.includes("diffusion")) return "diffusion_models";
  return "checkpoints";
}

function folderForWidget(node, widget) {
  const name = widget?.name || "";
  if (MODEL_WIDGET_FOLDERS[name]) return MODEL_WIDGET_FOLDERS[name];
  if (/^clip_name\d*$/.test(name)) {
    return node?.constructor?.comfyClass === "CLIPVisionLoader" ? "clip_vision" : "text_encoders";
  }
  if (/^vae_name\d*$/.test(name)) return "vae";
  if (/^unet_name\d*$/.test(name)) return "diffusion_models";
  return null;
}

function widgetLooksLikeModel(widget) {
  if (!widget || typeof widget.value !== "string") return false;
  const value = widget.value.trim();
  if (!value || value === "undefined" || value === "null") return false;
  return /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx|sft|pkl)$/i.test(value);
}

function getModelWidgets(node) {
  return (node?.widgets || []).filter((widget) => widgetLooksLikeModel(widget) || folderForWidget(node, widget));
}

function getFolderWidgets(node) {
  return (node?.widgets || [])
    .map((widget) => ({ widget, folder: folderForWidget(node, widget) }))
    .filter((entry) => entry.folder);
}

function isSubgraphNode(node) {
  if (typeof node.isSubgraphNode === "function") return node.isSubgraphNode();
  return node.isSubgraphNode === true || Boolean(node.subgraph);
}

// Model widgets on the node itself (including promoted subgraph widgets) and on every node nested inside it.
function getModelEntries(node) {
  const entries = [];
  const seen = new Set();
  const visit = (current) => {
    for (const widget of getModelWidgets(current)) {
      const folder = folderForWidget(current, widget) || inferFolderFromNode(current);
      const key = `${folder}|${widget.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ widget, folder });
    }
    if (isSubgraphNode(current)) (current.subgraph?.nodes || []).forEach(visit);
  };
  visit(node);
  return entries;
}

async function openModelFoldersForNode(node) {
  const entries = getModelEntries(node);
  if (!entries.length) {
    toast("No model-looking widgets found on this node.", true);
    return;
  }
  for (const { widget, folder } of entries) {
    await openFolder({ folder, filename: widget.value });
  }
}

async function openWidgetFolder(node, widget, folder) {
  await openFolder({
    folder,
    filename: typeof widget.value === "string" ? widget.value : undefined,
  });
}

function widgetIsMissing(widget) {
  const values = widget.options?.values;
  return Array.isArray(values) && typeof widget.value === "string" && widget.value !== "" && !values.includes(widget.value);
}

function workflowNodes() {
  const graph = app.graph?.rootGraph || app.graph;
  if (!graph) return [];
  return [...graph._nodes, ...[...(graph.subgraphs?.values() || [])].flatMap((subgraph) => subgraph.nodes || [])];
}

// Workflows (including the built-in templates) list download links per loader in node.properties.models.
function modelSources() {
  const sources = new Map();
  for (const node of workflowNodes()) {
    for (const model of node.properties?.models || []) {
      if (model?.name && model.url) sources.set(model.name, model);
    }
  }
  return sources;
}

function missingModel(widget, folder, sources) {
  if (!widgetIsMissing(widget)) return null;
  const source = sources.get(widget.value) || sources.get(widget.value.split(/[\\/]/).pop());
  return { name: widget.value, folder: source?.directory || folder, url: source?.url || "" };
}

function findMissingModels() {
  const sources = modelSources();
  const missing = new Map();
  for (const node of workflowNodes()) {
    for (const widget of getModelWidgets(node)) {
      const entry = missingModel(widget, folderForWidget(node, widget) || inferFolderFromNode(node), sources);
      if (entry && !missing.has(`${entry.folder}|${entry.name}`)) missing.set(`${entry.folder}|${entry.name}`, entry);
    }
  }
  return [...missing.values()];
}

function missingModelsForNode(node) {
  const sources = modelSources();
  return getModelEntries(node).map(({ widget, folder }) => missingModel(widget, folder, sources)).filter(Boolean);
}

function activeJobFor(entry) {
  return [...state.downloads.values()].find((job) => job.url === entry.url && ["queued", "downloading"].includes(job.status));
}

// Starts the download when the workflow knows the URL; otherwise opens the panel with everything but the URL filled in.
async function downloadModel(entry) {
  const parts = entry.name.split(/[\\/]/);
  const filename = parts.pop();
  const subfolder = parts.join("/");
  if (!entry.url) {
    await togglePanel({ folder: entry.folder, filename, subfolder, needUrl: entry.name });
    return;
  }
  await togglePanel();
  if (activeJobFor(entry)) return;
  await startJob({ folder: entry.folder, subfolder, url: entry.url, filename });
}

function downloadModels(entries) {
  return entries.reduce((chain, entry) => chain.then(() => downloadModel(entry)), Promise.resolve())
    .catch((error) => setPanelStatus(error.message, true));
}

function drawDownloadGlyph(ctx, x, y, size) {
  ctx.save();
  ctx.fillStyle = "#2f8f5f";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + size / 2, y + 3);
  ctx.lineTo(x + size / 2, y + size - 6);
  ctx.moveTo(x + size / 2 - 4, y + size - 9);
  ctx.lineTo(x + size / 2, y + size - 5);
  ctx.lineTo(x + size / 2 + 4, y + size - 9);
  ctx.moveTo(x + 4, y + size - 3);
  ctx.lineTo(x + size - 4, y + size - 3);
  ctx.stroke();
  ctx.restore();
}

function drawFolderGlyph(ctx, x, y, size, active = false) {
  const tabHeight = Math.max(4, Math.round(size * 0.28));
  const radius = 3;
  ctx.save();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = active ? "#ffffff" : "#d9d4b0";
  ctx.fillStyle = active ? "#b5862e" : "#8c6b2f";
  ctx.beginPath();
  ctx.roundRect(x, y + tabHeight, size, size - tabHeight, radius);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 2, y + tabHeight + 1);
  ctx.lineTo(x + 2, y + 3);
  ctx.lineTo(x + size * 0.42, y + 3);
  ctx.lineTo(x + size * 0.55, y + tabHeight + 1);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function pointInRect(pos, rect) {
  return pos?.[0] >= rect.x && pos[0] <= rect.x + rect.w && pos[1] >= rect.y && pos[1] <= rect.y + rect.h;
}

// Canvas (classic LiteGraph) rendering. Installed on every node because subgraph nodes
// gain their promoted model widgets after nodeCreated.
function installFolderIcons(node) {
  if (!node || node.__comfyqFolderIconsInstalled) return;
  node.__comfyqFolderIconsInstalled = true;

  const originalDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function comfyQDrawFolderIcons(ctx, ...args) {
    // Reserve space outside the combo's draw and click bounds for its folder icon.
    const widgets = getFolderWidgets(this);
    for (const { widget } of widgets) {
      const icons = widgetIsMissing(widget) ? 2 : 1;
      widget.width = Math.max(60, this.size[0] - icons * (FOLDER_ICON_SIZE + 4) - 6);
    }
    originalDrawForeground?.apply(this, [ctx, ...args]);
    this.__comfyqFolderIconRects = [];
    if (this.flags?.collapsed) return;

    for (const { widget, folder } of widgets) {
      if (widget.hidden || widget.type === "hidden" || typeof widget.y !== "number") continue;
      const height = widget.computedHeight || widget.computeSize?.(this.size[0])?.[1] || 20;
      const x = Math.max(6, this.size[0] - FOLDER_ICON_SIZE - FOLDER_ICON_MARGIN);
      const y = widget.y + Math.max(1, (height - FOLDER_ICON_SIZE) / 2);
      this.__comfyqFolderIconRects.push({ x, y, w: FOLDER_ICON_SIZE, h: FOLDER_ICON_SIZE, widget, folder, action: "open" });
      drawFolderGlyph(ctx, x, y, FOLDER_ICON_SIZE, false);
      if (widgetIsMissing(widget)) {
        const dx = x - FOLDER_ICON_SIZE - 4;
        this.__comfyqFolderIconRects.push({ x: dx, y, w: FOLDER_ICON_SIZE, h: FOLDER_ICON_SIZE, widget, folder, action: "download" });
        drawDownloadGlyph(ctx, dx, y, FOLDER_ICON_SIZE);
      }
    }
  };

  const originalMouseDown = node.onMouseDown;
  node.onMouseDown = function comfyQFolderIconMouseDown(event, pos, ...args) {
    const rects = this.__comfyqFolderIconRects || [];
    const hit = rects.find((rect) => pointInRect(pos, rect));
    if (hit) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const run = hit.action === "download"
        ? downloadModels([missingModel(hit.widget, hit.folder, modelSources())].filter(Boolean))
        : openWidgetFolder(this, hit.widget, hit.folder);
      run.catch((error) => toast(error.message, true));
      return true;
    }
    return originalMouseDown?.apply(this, [event, pos, ...args]);
  };
}

const DOWNLOAD_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="0.5" y="0.5" width="15" height="15" rx="3.5" fill="#2f8f5f"/><path d="M8 3v7M4.5 7 8 10.5 11.5 7M4 13h8" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const FOLDER_SVG = `<svg viewBox="0 0 16 14" width="14" height="12" aria-hidden="true"><path d="M1 3V1.5h5l1.5 1.5H15v10H1z" fill="#8c6b2f" stroke="#d9d4b0" stroke-width="1.2" stroke-linejoin="round"/></svg>`;

// Vue node rendering (Nodes 2.0) draws widgets as DOM, so the canvas icons never appear there.
// Prepend a folder button to each model widget label; Vue may re-render labels, so this re-runs on DOM changes.
function syncVueFolderIcons() {
  const graph = app.canvas?.graph;
  if (!graph) return;
  for (const labelEl of document.querySelectorAll('.lg-node [data-testid="widget-layout-field-label"]')) {
    const node = graph.getNodeById(labelEl.closest("[data-node-id]")?.dataset.nodeId);
    const label = labelEl.textContent.trim();
    const widget = node?.widgets?.find((w) => (w.label || w.name) === label);
    const folder = widget && folderForWidget(node, widget);
    if (!folder) continue;
    const downloadButton = labelEl.querySelector(".comfyq-vue-download");
    if (widgetIsMissing(widget) && !downloadButton) {
      labelEl.prepend(
        el("button", {
          class: "comfyq-vue-download",
          title: `comfyQ: download missing ${widget.value} into ${folder}`,
          html: DOWNLOAD_SVG,
          onpointerdown: (event) => event.stopPropagation(),
          onclick: (event) => {
            event.stopPropagation();
            downloadModels([missingModel(widget, folder, modelSources())].filter(Boolean));
          },
        }),
      );
    } else if (!widgetIsMissing(widget) && downloadButton) {
      downloadButton.remove();
    }
    if (labelEl.querySelector(".comfyq-vue-folder")) continue;
    labelEl.prepend(
      el("button", {
        class: "comfyq-vue-folder",
        title: `comfyQ: open ${folder} folder`,
        html: FOLDER_SVG,
        onpointerdown: (event) => event.stopPropagation(),
        onclick: (event) => {
          event.stopPropagation();
          openWidgetFolder(node, widget, folder).catch((error) => toast(error.message, true));
        },
      }),
    );
  }
}

function watchVueNodes() {
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      syncVueFolderIcons();
    });
  }).observe(document.body, { childList: true, subtree: true });
  syncVueFolderIcons();
}

function rootGraphForEdit() {
  const graph = app.graph?.rootGraph || app.graph;
  if (graph && app.canvas?.graph !== graph) app.canvas?.setGraph(graph);
  return graph;
}

// Flatten every subgraph (including nested ones) back into the root workflow, keeping all nodes and links.
function unpackAllSubgraphs() {
  const graph = rootGraphForEdit();
  if (!graph) return;
  const failed = new Set();
  let unpacked = 0;
  graph.beforeChange?.();
  let candidates;
  while ((candidates = graph._nodes.filter((node) => isSubgraphNode(node) && !failed.has(node))).length) {
    for (const node of candidates) {
      graph.unpackSubgraph(node);
      if (graph._nodes.includes(node)) failed.add(node);
      else unpacked += 1;
    }
  }
  graph.setDirtyCanvas(true, true);
  graph.afterChange?.();
  toast(failed.size
    ? `Unpacked ${unpacked} subgraph(s); ${failed.size} could not be unpacked (missing node types?).`
    : `Unpacked ${unpacked} subgraph(s).`);
}

function removeAllSubgraphs() {
  const graph = rootGraphForEdit();
  if (!graph) return;
  const candidates = graph._nodes.filter(isSubgraphNode);

  graph.beforeChange?.();
  for (const node of candidates) graph.remove(node);

  let definitionCount = 0;
  if (graph.subgraphs instanceof Map) {
    definitionCount += graph.subgraphs.size;
    graph.subgraphs.clear();
  }
  if (graph.extra?.groupNodes && typeof graph.extra.groupNodes === "object") {
    definitionCount = Object.keys(graph.extra.groupNodes).length;
    graph.extra.groupNodes = {};
  }
  if (graph.extra?.subgraphs && typeof graph.extra.subgraphs === "object") {
    definitionCount += Object.keys(graph.extra.subgraphs).length;
    graph.extra.subgraphs = {};
  }

  graph.setDirtyCanvas(true, true);
  graph.afterChange?.();
  toast(`Removed ${candidates.length} subgraph node(s) and ${definitionCount} embedded definition(s).`);
}

function selectedModelNames() {
  const selected = Object.values(app.canvas?.selected_nodes || {});
  return [...new Set(selected.flatMap((node) => getModelEntries(node).map(({ widget }) => widget.value)))];
}

async function copySelectedModelNames() {
  const names = selectedModelNames();
  if (!names.length) {
    toast("Select one or more model loader nodes first.", true);
    return;
  }
  await navigator.clipboard.writeText(names.join("\n"));
  toast(`Copied ${names.length} model name(s).`);
}

function ensurePanel() {
  if (state.panel) return state.panel;

  const folderSelect = el("select", { class: "comfyq-select" });
  const pathSelect = el("select", { class: "comfyq-select" });
  const urlInput = el("input", {
    class: "comfyq-input",
    placeholder: "https://.../model.safetensors",
  });
  const filenameInput = el("input", {
    class: "comfyq-input",
    placeholder: "optional filename",
  });
  const subfolderInput = el("input", {
    class: "comfyq-input",
    placeholder: "optional subfolder",
  });
  const status = el("div", { class: "comfyq-status", text: "Ready" });
  const downloads = el("div", { class: "comfyq-downloads" });
  const missingSection = el("div", { class: "comfyq-missing" });
  state.downloadsEl = downloads;
  state.missingEl = missingSection;

  function refreshPathOptions() {
    const folder = state.info?.model_folders?.find((item) => item.name === folderSelect.value);
    pathSelect.replaceChildren();
    for (const [index, path] of (folder?.folders || []).entries()) {
      pathSelect.append(el("option", { value: index, text: `${index}: ${path}` }));
    }
  }

  const setStatus = setPanelStatus;

  async function refreshInfo() {
    await loadInfo(true);
    const previous = folderSelect.value;
    folderSelect.replaceChildren();
    for (const folder of state.info.model_folders) {
      folderSelect.append(el("option", { value: folder.name, text: folder.name }));
    }
    folderSelect.value = previous || "checkpoints";
    refreshPathOptions();
  }

  async function startDownload() {
    try {
      await startJob({
        folder: folderSelect.value,
        path_index: Number(pathSelect.value || 0),
        subfolder: subfolderInput.value.trim(),
        url: urlInput.value.trim(),
        filename: filenameInput.value.trim(),
      });
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  const panel = el("div", { class: "comfyq-panel" }, [
      el("div", { class: "comfyq-header" }, [
      el("strong", { text: `comfyQ v${state.info?.version || "1.02"}` }),
      el("button", { class: "comfyq-icon", title: "Close", text: "x", onclick: () => panel.classList.remove("open") }),
    ]),
    el("div", { class: "comfyq-row" }, [
      el("button", { text: "Input", onclick: () => openFolder({ special: "input" }) }),
      el("button", { text: "Output", onclick: () => openFolder({ special: "output" }) }),
      el("button", { text: "Custom Nodes", onclick: () => openFolder({ special: "custom_nodes" }) }),
    ]),
    missingSection,
    el("label", { text: "Model type" }),
    folderSelect,
    el("label", { text: "Target folder" }),
    pathSelect,
    el("div", { class: "comfyq-row" }, [
      el("button", { text: "Open Folder", onclick: () => openFolder({ folder: folderSelect.value, path_index: Number(pathSelect.value || 0) }) }),
      el("button", { text: "Refresh Models", onclick: async () => {
        try {
          await app.refreshComboInNodes();
          await refreshInfo();
          setStatus("Model lists refreshed.");
        } catch (error) { setStatus(error.message, true); }
      } }),
    ]),
    el("label", { text: "Download a model from a URL" }),
    urlInput,
    filenameInput,
    subfolderInput,
    el("button", { class: "comfyq-primary", text: "Download to Selected Folder", onclick: startDownload }),
    el("div", { class: "comfyq-row" }, [
      el("button", { text: "Unpack Subgraphs", title: "Flatten all subgraphs into the workflow, keeping their nodes", onclick: unpackAllSubgraphs }),
      el("button", { text: "Remove Subgraphs", title: "Delete subgraph nodes and their contents", onclick: removeAllSubgraphs }),
    ]),
    el("button", { text: "Copy Selected Models", onclick: copySelectedModelNames }),
    status,
    downloads,
  ]);

  const header = $(".comfyq-header", panel);
  header.title = "Drag to move comfyQ; use arrow keys when focused";
  header.setAttribute("aria-label", "Move comfyQ panel");
  makeMovable(panel, header, PANEL_POSITION_KEY);
  folderSelect.addEventListener("change", refreshPathOptions);
  document.body.append(panel);
  state.panel = panel;
  refreshInfo().catch((error) => setStatus(error.message, true));
  return panel;
}

async function togglePanel(prefill = {}) {
  await loadInfo();
  const panel = ensurePanel();
  panel.classList.toggle("open", true);
  restoreElementPosition(panel, PANEL_POSITION_KEY);
  if (prefill.folder) {
    const select = $(".comfyq-select", panel);
    // Populate first: opening from a node can precede the panel's initial refresh.
    if (!select.options.length) {
      for (const folder of state.info.model_folders) {
        select.append(el("option", { value: folder.name, text: folder.name }));
      }
    }
    select.value = prefill.folder;
    select.dispatchEvent(new Event("change"));
  }
  const [urlInput, filenameInput, subfolderInput] = panel.querySelectorAll(".comfyq-input");
  if (prefill.filename) filenameInput.value = prefill.filename;
  if (prefill.subfolder !== undefined) subfolderInput.value = prefill.subfolder;
  urlInput.classList.toggle("comfyq-needs-url", Boolean(prefill.needUrl));
  urlInput.placeholder = prefill.needUrl ? `Paste a download URL for ${prefill.needUrl}` : "https://.../model.safetensors";
  if (prefill.needUrl) {
    urlInput.value = "";
    urlInput.scrollIntoView({ block: "center" });
    urlInput.focus();
    setPanelStatus(`No download link in this workflow for ${prefill.needUrl}. Paste one, then click Download to Selected Folder.`, true);
  }
  renderMissingModels(true);
}

function setPanelStatus(message, error = false) {
  const status = state.panel && $(".comfyq-status", state.panel);
  if (!status) return;
  status.textContent = message;
  status.dataset.error = error ? "true" : "false";
}

async function startJob(body) {
  setPanelStatus("Starting download...");
  const job = await comfyQFetch("/comfyq/download", { method: "POST", body: JSON.stringify(body) });
  state.downloads.set(job.id, job);
  renderDownloads(state.downloadsEl);
  renderMissingModels(true);
  setPanelStatus(`Downloading ${job.filename}`);
  pollDownload(job.id, state.downloadsEl);
}

// Panel list of models this workflow needs but are not installed. Re-rendered only when the list changes.
function renderMissingModels(force = false) {
  const container = state.missingEl;
  if (!container || !state.panel?.classList.contains("open")) return;
  const missing = findMissingModels();
  const signature = JSON.stringify(missing.map((entry) => [entry.name, entry.folder, entry.url, Boolean(activeJobFor(entry))]));
  if (!force && container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  if (!missing.length) {
    container.replaceChildren(el("div", { class: "comfyq-ok", text: "All models in this workflow are installed." }));
    return;
  }
  const withUrl = missing.filter((entry) => entry.url && !activeJobFor(entry));
  container.replaceChildren(
    el("div", { class: "comfyq-missing-head" }, [
      el("strong", { text: `Missing models (${missing.length})` }),
      withUrl.length > 1 ? el("button", { class: "comfyq-primary", text: `Download all (${withUrl.length})`, onclick: () => downloadModels(withUrl) }) : null,
    ]),
    ...missing.map((entry) => el("div", { class: "comfyq-missing-row" }, [
      el("div", { class: "comfyq-missing-name" }, [
        el("span", { text: entry.name, title: entry.url || "No download link in this workflow" }),
        el("small", { text: entry.folder }),
      ]),
      activeJobFor(entry)
        ? el("span", { class: "comfyq-muted", text: "downloading" })
        : el("button", {
          class: entry.url ? "comfyq-primary" : "",
          text: entry.url ? "Download" : "Add URL",
          title: entry.url || "No download link in this workflow; paste one below",
          onclick: () => downloadModels([entry]),
        }),
    ])),
  );
}

function updateLauncher() {
  const launcher = state.launcher;
  if (!launcher) return;
  const count = findMissingModels().length;
  launcher.textContent = count ? `comfyQ · ${count} missing` : `comfyQ v${state.info?.version || ""}`;
  launcher.classList.toggle("comfyq-has-missing", count > 0);
  renderMissingModels();
}

function renderDownloads(container) {
  const jobs = [...state.downloads.values()].reverse();
  container.replaceChildren(
    ...jobs.map((job) => {
      const total = job.total_bytes || 0;
      const pct = total ? Math.floor((job.bytes_downloaded / total) * 100) : 0;
      const label = job.status === "downloading" ? (total ? `${pct}%` : `${(job.bytes_downloaded / 1048576).toFixed(1)} MB`) : job.status;
      return el("div", { class: "comfyq-job" }, [
        el("span", { text: job.filename }),
        el("span", { text: label }),
      ]);
    }),
  );
}

async function pollDownload(id, container) {
  let keepGoing = true;
  while (keepGoing) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const job = await comfyQFetch(`/comfyq/downloads/${id}`);
    state.downloads.set(id, job);
    renderDownloads(container);
    keepGoing = ["queued", "downloading"].includes(job.status);
    if (job.status === "complete") {
      await app.refreshComboInNodes();
      setPanelStatus(`Downloaded ${job.filename}`);
      if (!state.panel?.classList.contains("open")) toast(`Downloaded ${job.filename}`);
      updateLauncher();
    }
    if (job.status === "error") {
      setPanelStatus(`${job.filename}: ${job.error || "Download failed"}`, true);
      if (!state.panel?.classList.contains("open")) toast(job.error || "Download failed", true);
      renderMissingModels(true);
    }
  }
}

function injectStyles() {
  if ($("#comfyq-style")) return;
  document.head.append(
    el("style", {
      id: "comfyq-style",
      text: `
        .comfyq-launcher {
          position: fixed; right: 18px; bottom: 76px; z-index: 9999; touch-action: none;
          border: 1px solid var(--border-color, #555); background: var(--comfy-menu-bg, #222);
          color: var(--fg-color, #eee); border-radius: 6px; padding: 8px 10px; cursor: pointer;
          box-shadow: 0 8px 24px rgba(0,0,0,.25);
        }
        .comfyq-panel {
          position: fixed; right: 18px; bottom: 122px; width: min(380px, calc(100vw - 32px));
          display: none; z-index: 9999; padding: 12px; gap: 8px; flex-direction: column;
          color: var(--fg-color, #eee); background: var(--comfy-menu-bg, #242424);
          border: 1px solid var(--border-color, #555); border-radius: 8px;
          box-shadow: 0 12px 34px rgba(0,0,0,.35); font-size: 14px;
          max-height: calc(100vh - 90px); overflow-y: auto;
        }
        .comfyq-panel.open { display: flex; }
        .comfyq-header, .comfyq-row, .comfyq-job { display: flex; align-items: center; gap: 8px; }
        .comfyq-header { cursor: grab; touch-action: none; user-select: none; }
        .comfyq-header.dragging { cursor: grabbing; }
        .comfyq-header, .comfyq-job { justify-content: space-between; }
        .comfyq-panel button, .comfyq-input, .comfyq-select {
          min-height: 30px; border-radius: 6px; border: 1px solid var(--border-color, #555);
          background: var(--comfy-input-bg, #111); color: var(--fg-color, #eee);
        }
        .comfyq-panel button { cursor: pointer; padding: 4px 8px; }
        .comfyq-primary { background: #2f6f55 !important; }
        .comfyq-icon { width: 28px; }
        .comfyq-input, .comfyq-select { width: 100%; padding: 4px 7px; box-sizing: border-box; }
        .comfyq-status[data-error="true"] { color: #ff8e8e; }
        .comfyq-downloads { display: flex; flex-direction: column; gap: 4px; }
        .comfyq-job { font-size: 12px; opacity: .9; }
        .comfyq-launcher.dragging { cursor: grabbing; opacity: .85; }
        .comfyq-launcher.comfyq-has-missing { background: #2f6f55; border-color: #5fbf8f; color: #fff; }
        .comfyq-missing { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 6px; background: rgba(127,127,127,.12); }
        .comfyq-missing-head, .comfyq-missing-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .comfyq-missing-name { display: flex; flex-direction: column; min-width: 0; }
        .comfyq-missing-name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .comfyq-missing-name small, .comfyq-muted { opacity: .65; font-size: 12px; }
        .comfyq-ok { font-size: 12px; opacity: .75; }
        .comfyq-needs-url { border-color: #e0a040 !important; box-shadow: 0 0 0 2px rgba(224,160,64,.35); }
        .comfyq-vue-folder, .comfyq-vue-download {
          display: inline-flex; align-items: center; vertical-align: middle; margin-right: 4px;
          padding: 0; border: 0; background: none; cursor: pointer; pointer-events: auto;
        }
        .comfyq-vue-folder:hover svg path { fill: #b5862e; stroke: #fff; }
        .comfyq-vue-download:hover svg rect { fill: #3fb27a; }
      `,
    }),
  );
}

function resetPositions() {
  for (const [element, key] of [[state.launcher, LAUNCHER_POSITION_KEY], [state.panel, PANEL_POSITION_KEY]]) {
    try { localStorage.removeItem(key); } catch {}
    if (element) for (const side of ["left", "top", "right", "bottom"]) element.style[side] = "";
  }
}

app.registerExtension({
  name: "comfyQ.QualityOfLife",
  commands: [
    { id: "comfyQ.openPanel", label: "comfyQ: Open Panel", function: () => togglePanel() },
    { id: "comfyQ.downloadMissing", label: "comfyQ: Download Missing Models", function: () => downloadModels(findMissingModels().filter((entry) => entry.url)) },
    { id: "comfyQ.resetPosition", label: "comfyQ: Reset Button Position", function: resetPositions },
  ],
  menuCommands: [
    { path: ["Extensions", "comfyQ"], commands: ["comfyQ.openPanel", "comfyQ.downloadMissing", "comfyQ.resetPosition"] },
  ],
  async setup() {
    injectStyles();
    watchVueNodes();
    await loadInfo();
    state.launcher = el("button", {
      class: "comfyq-launcher",
      title: "Open comfyQ (drag to move)",
      text: `comfyQ v${state.info.version}`,
      onclick: () => togglePanel(),
    });
    document.body.append(state.launcher);
    makeMovable(state.launcher, state.launcher, LAUNCHER_POSITION_KEY);
    restoreElementPosition(state.launcher, LAUNCHER_POSITION_KEY);
    setInterval(() => {
      updateLauncher();
      syncVueFolderIcons();
    }, 2000);
  },
  nodeCreated(node) {
    installFolderIcons(node);
  },
  getCanvasMenuItems() {
    return [
      null,
      { content: "comfyQ: Open Panel", callback: () => togglePanel() },
      { content: "comfyQ: Download Missing Models", callback: () => downloadModels(findMissingModels().filter((entry) => entry.url)) },
      { content: "comfyQ: Unpack All Subgraphs", callback: unpackAllSubgraphs },
      { content: "comfyQ: Remove All Subgraphs", callback: removeAllSubgraphs },
      { content: "comfyQ: Copy Selected Model Names", callback: copySelectedModelNames },
      { content: "comfyQ: Open Output Folder", callback: () => openFolder({ special: "output" }) },
    ];
  },
  getNodeMenuItems(node) {
    const items = [];
    const entries = getModelEntries(node);
    if (entries.length) {
      items.push({
        content: "comfyQ: Open Model Folder",
        callback: () => openModelFoldersForNode(node),
      });
      const missing = missingModelsForNode(node);
      items.push(missing.length
        ? { content: `comfyQ: Download Missing Model${missing.length === 1 ? "" : "s"} (${missing.length})`, callback: () => downloadModels(missing) }
        : { content: "comfyQ: Download Model Here", callback: () => togglePanel({ folder: entries[0].folder }) });
    }
    return items;
  },
});
