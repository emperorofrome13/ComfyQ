# comfyQ

Quality-of-life tools for ComfyUI: open model folders from the node, find the models a
workflow is missing and download them in one click, and flatten subgraphs.

Works with both node renderers: **Nodes 1** (classic canvas) and **Nodes 2** (Vue nodes).
It adds no workflow nodes, so it never changes how a workflow runs or saves.

## Features

- **Missing models, one click.** The `comfyQ` button shows `comfyQ · N missing` when the
  open workflow needs models you don't have (including models inside subgraphs). The panel
  lists them with **Download** and **Download all**, and a green download button appears
  beside each missing model on the node. Links come from the workflow's own model metadata
  (`properties.models`, which the built-in templates include). Models without a link get
  **Add URL**, which fills in the folder and filename so you only paste the link.
- **Folder icons** beside model pickers (`unet_name`, `clip_name`, `vae_name`, `ckpt_name`,
  `lora_name`, ControlNet, upscale, CLIP vision, style) open the folder that holds that
  model, searching all of ComfyUI's configured model folders.
- **Subgraph-aware.** Icons and menu items work on promoted widgets on a subgraph node and on
  loaders nested inside it.
- **Unpack Subgraphs** flattens every subgraph (including nested ones) back into the
  workflow, keeping all nodes and links. **Remove Subgraphs** deletes them instead.
- Download any model from a URL into a chosen model folder, with progress. Partial files
  are kept as `.part` until complete, and model lists refresh when a download finishes.
- Open the input, output, and custom_nodes folders; copy the model names of selected nodes.
- The `comfyQ` button and panel can be dragged anywhere and remember their position.
  Everything is also under **Extensions → comfyQ** in the top menu, including
  **Reset Button Position**. Right-click a node or the canvas for comfyQ menu items.

## Install

With git, from your `ComfyUI/custom_nodes` folder:

```bash
git clone https://github.com/emperorofrome13/comfyQ
```

Or download the ZIP from GitHub, extract it, and place the folder at
`ComfyUI/custom_nodes/comfyQ` (for the Windows portable build:
`ComfyUI_windows_portable/ComfyUI/custom_nodes/comfyQ`).

With ComfyUI-Manager: **Install via Git URL** and paste the repository URL.

Restart ComfyUI. The `comfyQ` button appears at the bottom right, above the canvas toolbar.
No extra Python packages are needed.

## Compatibility

Tested on ComfyUI 0.40 and 0.42 (frontend 1.55) in both Nodes 1 and Nodes 2 mode. Older
ComfyUI versions load it too; subgraph features need a frontend that has subgraphs.
Third-party loader nodes are covered when their model widgets use the standard names above,
or when the selected value ends in a model file extension (for the menu items).

## Security

comfyQ adds server routes that open folders on the machine running ComfyUI and download
files into its model folders. Anyone who can reach your ComfyUI server can use them, the same
as the rest of ComfyUI's API. If you run ComfyUI with `--listen` on a shared network, keep
that in mind. Downloads only accept `http://`/`https://` URLs, and folder and file names are
checked so they stay inside ComfyUI's model folders.

## Limitations

- comfyQ does not search the web for models whose workflow has no download link.
- Gated/login-only downloads (some Hugging Face and Civitai models), resume, and cancel are
  not supported yet. Download history is kept in server memory until restart.
- Folder windows open on the computer running ComfyUI, not the one with the browser.

## Development

From the `comfyQ` folder inside a ComfyUI install (or set `COMFYUI_PATH` to the ComfyUI folder):

```bash
python tests/test_paths.py
node tests/test_extension.cjs
```

## License

MIT. See [LICENSE](LICENSE).
