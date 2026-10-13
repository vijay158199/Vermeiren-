// Builds the photo-search index: one CLIP embedding per drawing picture and per shape description.
// Runs on GitHub Actions (needs internet for the model). Output: emb/meta.json, emb/img.bin, emb/txt.bin
import fs from "node:fs";
import sharp from "sharp";
import { AutoProcessor, CLIPVisionModelWithProjection, AutoTokenizer, CLIPTextModelWithProjection, RawImage } from "@huggingface/transformers";

const html = fs.readFileSync("index.html", "utf8");
const grab = name => JSON.parse(html.match(new RegExp("const " + name + "=(.*?);\\n"))[1]);
const BASE = grab("BASE"), SHAPES = grab("SHAPES"), PACKS = grab("PACKS");
const part = {}; for (const r of BASE) if (!part[r.img] && r.part) part[r.img] = r.part;
const ids = Object.keys(PACKS);
const MODELS = ["Xenova/mobileclip_s0", "Xenova/clip-vit-base-patch32"];
const DTYPE = "q8";

async function load(id) {
  const processor = await AutoProcessor.from_pretrained(id);
  const vision = await CLIPVisionModelWithProjection.from_pretrained(id, { dtype: DTYPE });
  const tokenizer = await AutoTokenizer.from_pretrained(id);
  const text = await CLIPTextModelWithProjection.from_pretrained(id, { dtype: DTYPE });
  return { processor, vision, tokenizer, text };
}
let M, modelId;
for (const id of MODELS) { try { M = await load(id); modelId = id; break; } catch (e) { console.log("model failed", id, e.message); } }
if (!M) throw new Error("no model loaded");
console.log("model", modelId, "drawings", ids.length);

const norm = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Array.from(v, x => x / s); };
const q8 = v => Int8Array.from(v, x => Math.max(-127, Math.min(127, Math.round(x * 127))));
const packs = {};
const slice = id => { const [p, o, l] = PACKS[id]; packs[p] ??= fs.readFileSync("packs/" + p + ".jpg"); return packs[p].subarray(o, o + l); };

// Crop to the drawing area: leave out the title block (bottom right) and the side tables
async function drawingArea(buf) {
  const { width: w, height: h } = await sharp(buf).metadata();
  const box = w >= h ? { left: 0, top: 0, width: Math.round(w * 0.72), height: Math.round(h * 0.80) } : { left: 0, top: 0, width: w, height: Math.round(h * 0.70) };
  const { data, info } = await sharp(buf).extract(box).flatten({ background: "#ffffff" }).toColourspace("srgb").removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return new RawImage(new Uint8ClampedArray(data), info.width, info.height, info.channels);
}

let dim = 0;
const imgOut = [], txtOut = [];
for (const [i, id] of ids.entries()) {
  const inputs = await M.processor(await drawingArea(slice(id)));
  const { image_embeds } = await M.vision(inputs);
  const v = norm(image_embeds.data); dim = v.length; imgOut.push(q8(v));
  if (i % 200 === 0) console.log("images", i);
}
const texts = ids.map(id => `a photo of a metal wheelchair part: ${part[id] || ""}. ${SHAPES[id] || ""}`.slice(0, 300));
for (let i = 0; i < texts.length; i += 64) {
  const tok = M.tokenizer(texts.slice(i, i + 64), { padding: true, truncation: true });
  const { text_embeds } = await M.text(tok);
  const d = text_embeds.dims[1];
  for (let j = 0; j < text_embeds.dims[0]; j++) txtOut.push(q8(norm(text_embeds.data.slice(j * d, (j + 1) * d))));
}
fs.mkdirSync("emb", { recursive: true });
const cat = arr => { const out = new Int8Array(arr.length * dim); arr.forEach((v, i) => out.set(v, i * dim)); return Buffer.from(out.buffer); };
fs.writeFileSync("emb/img.bin", cat(imgOut));
fs.writeFileSync("emb/txt.bin", cat(txtOut));
fs.writeFileSync("emb/meta.json", JSON.stringify({ model: modelId, dtype: DTYPE, dim, ids, built: new Date().toISOString() }));
console.log("done", modelId, dim, ids.length);
