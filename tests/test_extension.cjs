const fs = require("node:fs");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const path = require("node:path");

let extension;
const messages = [];
const ordinary = { type: "VAELoader", isSubgraphNode: () => false };
const subgraph = { type: "uuid", isSubgraphNode: () => true };
const graph = {
  _nodes: [ordinary, subgraph],
  subgraphs: new Map([["uuid", {}]]),
  extra: {},
  remove(node) { this._nodes.splice(this._nodes.indexOf(node), 1); },
  setDirtyCanvas() {}, beforeChange() {}, afterChange() {},
};
const app = {
  graph, canvas: {graph}, ui: {dialog: {show: message => messages.push(message)}},
  registerExtension(value) { extension = value; },
};
const file = path.join(__dirname, "../web/comfyq.js");
const source = fs.readFileSync(file, "utf8").replace(/^import .*;\r?\n/gm, "");
vm.runInNewContext(source, { app, api: {}, console, Map });
const remove = extension.getCanvasMenuItems().find(item => item?.content === "comfyQ: Remove All Subgraphs").callback;
remove();
assert.deepEqual(graph._nodes, [ordinary]);
assert.equal(graph.subgraphs.size, 0);
remove();
assert.deepEqual(graph._nodes, [ordinary]);

const node = {type:"DualCLIPLoader",size:[300,100],flags:{},widgets:[
  {name:"clip_name1",y:25,value:"first.safetensors"},
  {name:"clip_name2",y:50,value:"second.safetensors"},
]};
extension.nodeCreated(node);
const ctx = new Proxy({}, {get:()=>()=>{},set:()=>true});
node.onDrawForeground(ctx);
assert.equal(node.__comfyqFolderIconRects.length,2);
for (const rect of node.__comfyqFolderIconRects) {
  assert.equal(rect.folder,"text_encoders");
  assert.ok(rect.x > rect.widget.width - 6, "Icon must be outside the combo click bounds");
}

// Promoted widgets appear after nodeCreated; icons must still be drawn for them.
const promoted = {type:"uuid",size:[300,100],flags:{},widgets:[],isSubgraphNode:()=>true,subgraph:{nodes:[
  {type:"UNETLoader",widgets:[{name:"unet_name",value:"z.safetensors"}]},
  {type:"VAELoader",widgets:[{name:"vae_name",value:"ae.safetensors"}]},
]}};
extension.nodeCreated(promoted);
promoted.widgets.push({name:"unet_name",y:25,value:"z.safetensors"});
promoted.onDrawForeground(ctx);
assert.equal(promoted.__comfyqFolderIconRects.length,1);
assert.equal(promoted.__comfyqFolderIconRects[0].folder,"diffusion_models");
const menu = extension.getNodeMenuItems(promoted);
assert.equal(menu.length,2,"Subgraph node with inner loaders gets model menu items");

// Unpack flattens nested subgraphs and stops on ones that cannot be unpacked.
const inner = {type:"inner", isSubgraphNode:()=>true};
const outer = {type:"outer", isSubgraphNode:()=>true};
const broken = {type:"broken", isSubgraphNode:()=>true};
graph._nodes = [ordinary, outer, broken];
graph.unpackSubgraph = function(node) {
  if (node === broken) return;
  this._nodes.splice(this._nodes.indexOf(node), 1, ...(node === outer ? [inner] : [{type:"KSampler"}]));
};
messages.length = 0;
extension.getCanvasMenuItems().find(item => item?.content === "comfyQ: Unpack All Subgraphs").callback();
assert.deepEqual(graph._nodes.map(n => n.type), ["VAELoader", "KSampler", "broken"]);
assert.match(messages[0], /Unpacked 2 subgraph\(s\); 1 could not/);
// Missing models: value not in the combo list; URL comes from the workflow's properties.models.
const missingLoader = {type:"UNETLoader",properties:{models:[{name:"z.safetensors",directory:"diffusion_models",url:"https://example.test/z.safetensors"}]},
  widgets:[{name:"unet_name",value:"z.safetensors",options:{values:["other.safetensors"]}}]};
const installedLoader = {type:"VAELoader",widgets:[{name:"vae_name",value:"ae.safetensors",options:{values:["ae.safetensors"]}}]};
graph._nodes = [missingLoader, installedLoader];
graph.subgraphs = new Map();
const missingMenu = extension.getNodeMenuItems(missingLoader).map(i => i.content);
assert.ok(missingMenu.includes("comfyQ: Download Missing Model (1)"), missingMenu.join());
assert.ok(extension.getNodeMenuItems(installedLoader).map(i => i.content).includes("comfyQ: Download Model Here"));
extension.nodeCreated(missingLoader);
missingLoader.size = [300,100]; missingLoader.flags = {}; missingLoader.widgets[0].y = 25;
missingLoader.onDrawForeground(ctx);
assert.equal(missingLoader.__comfyqFolderIconRects.map(r => r.action).join(), "open,download");
console.log("PASS: ordinary nodes preserved, subgraphs removed, repeat removal safe, dual CLIP icons outside combo bounds, promoted/nested subgraph models, unpack, missing-model detection.");
