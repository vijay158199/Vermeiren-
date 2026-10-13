// Free photo search: a small AI model (CLIP) runs inside the visitor's browser.
// Drawings were turned into number fingerprints ahead of time (emb/, built by GitHub Actions);
// the photo gets the same kind of fingerprint and the closest drawings are shown.
const TF = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";
let engine = null;

async function loadIndex() {
  const meta = await (await fetch("emb/meta.json", { cache: "no-cache" })).json();
  const bin = async f => new Int8Array(await (await fetch(f + "?v=" + encodeURIComponent(meta.built))).arrayBuffer());
  const [img, txt] = await Promise.all([bin("emb/img.bin"), bin("emb/txt.bin")]);
  const row = {}; meta.ids.forEach((id, i) => (row[id] = i));
  return { meta, img, txt, row };
}

function getEngine(progress) {
  return engine || (engine = (async () => {
    const [index, T] = await Promise.all([loadIndex(), import(TF)]);
    T.env.allowLocalModels = false;
    const files = {};
    const cb = p => {
      if (p.status === "progress" && p.total) { files[p.file] = [p.loaded, p.total]; const v = Object.values(files);
        progress(Math.round(100 * v.reduce((a, x) => a + x[0], 0) / v.reduce((a, x) => a + x[1], 0))); }
    };
    const id = index.meta.model;
    const processor = await T.AutoProcessor.from_pretrained(id, { progress_callback: cb });
    let vision;
    try { vision = await T.CLIPVisionModelWithProjection.from_pretrained(id, { dtype: index.meta.dtype, device: "webgpu", progress_callback: cb }); }
    catch (_) { vision = await T.CLIPVisionModelWithProjection.from_pretrained(id, { dtype: index.meta.dtype, progress_callback: cb }); }
    return { T, index, processor, vision };
  })().catch(e => { engine = null; throw e; }));
}

// Canvas helpers: the photo as is, a centre crop, and a "pencil sketch" version that looks more like a drawing
async function canvases(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const mk = (cw, ch) => { const c = document.createElement("canvas"); c.width = cw; c.height = ch; return c; };
  const full = mk(w, h); full.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const cs = Math.round(Math.min(w, h) * 0.8), centre = mk(cs, cs);
  centre.getContext("2d").drawImage(full, (w - cs) / 2, (h - cs) / 2, cs, cs, 0, 0, cs, cs);
  const sketch = mk(w, h), sx = sketch.getContext("2d");
  const src = full.getContext("2d").getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * src[4 * i] + 0.587 * src[4 * i + 1] + 0.114 * src[4 * i + 2];
  const out = sx.createImageData(w, h), mags = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x;
    const gx = g[p - w + 1] + 2 * g[p + 1] + g[p + w + 1] - g[p - w - 1] - 2 * g[p - 1] - g[p + w - 1];
    const gy = g[p + w - 1] + 2 * g[p + w] + g[p + w + 1] - g[p - w - 1] - 2 * g[p - w] - g[p - w + 1];
    mags[p] = Math.hypot(gx, gy);
  }
  const sorted = Array.from(mags).sort((a, b) => a - b), thr = sorted[Math.floor(sorted.length * 0.9)] || 1;
  for (let p = 0; p < w * h; p++) { const v = mags[p] > thr ? 0 : 255; out.data[4 * p] = out.data[4 * p + 1] = out.data[4 * p + 2] = v; out.data[4 * p + 3] = 255; }
  sx.putImageData(out, 0, 0);
  return { full, centre, sketch };
}

async function embed(E, canvas) {
  const img = E.T.RawImage.fromCanvas ? E.T.RawImage.fromCanvas(canvas) : await E.T.RawImage.fromURL(canvas.toDataURL("image/jpeg", 0.9));
  const { image_embeds } = await E.vision(await E.processor(img));
  const v = Array.from(image_embeds.data); const n = Math.hypot(...v) || 1; return v.map(x => x / n);
}

function scores(bin, dim, n, q) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const o = i * dim; for (let d = 0; d < dim; d++) s += bin[o + d] * q[d]; out[i] = s / 127; }
  return out;
}
const zs = (a, keep) => { let m = 0, c = 0; keep.forEach(i => { m += a[i]; c++; }); m /= c || 1; let v = 0; keep.forEach(i => { v += (a[i] - m) ** 2; }); const sd = Math.sqrt(v / (c || 1)) || 1; return i => (a[i] - m) / sd; };

window.runPhoto = async function (files) {
  if (!Array.isArray(files)) files = [files];
  files = files.slice(0, 3);
  $("#panel").hidden = false; $("#matches").innerHTML = ""; $("#pimg").src = URL.createObjectURL(files[0]);
  $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
  const run = (window.__photoRun = (window.__photoRun || 0) + 1);
  try {
    say("<b>Step 1 of 3:</b> loading the matching engine. The first time this downloads about 40 MB, later it opens instantly…");
    const E = await getEngine(p => { if (run === window.__photoRun) say(`<b>Step 1 of 3:</b> downloading the matching engine (first time only): ${p}%`); });
    if (run !== window.__photoRun) return;
    say(`<b>Step 2 of 3:</b> studying your photo${files.length > 1 ? "s" : ""}…`);
    const { meta, img, txt, row } = E.index, dim = meta.dim, n = meta.ids.length;
    const photo = new Array(dim).fill(0), sk = new Array(dim).fill(0);
    for (const f of files) {
      const c = await canvases(f);
      const [a, b, s] = [await embed(E, c.full), await embed(E, c.centre), await embed(E, c.sketch)];
      for (let d = 0; d < dim; d++) { photo[d] += a[d] + b[d]; sk[d] += s[d]; }
    }
    const unit = v => { const k = Math.hypot(...v) || 1; return v.map(x => x / k); };
    const qp = unit(photo), qs = unit(sk);
    if (run !== window.__photoRun) return;
    say("<b>Step 3 of 3:</b> comparing with every drawing…");
    const pool = ALL.filter(r => !model || r.model === model);
    const keep = [...new Set(pool.map(r => r.img))].filter(id => id in row).map(id => row[id]);
    if (!keep.length) { say(model ? "No drawings in this model can be searched by photo yet. Choose All models and try again." : "The photo index is still being built. Try again in a few minutes."); return; }
    const sp = scores(img, dim, n, qp), ss = scores(img, dim, n, qs), st = scores(txt, dim, n, qp);
    const zp = zs(sp, keep), zk = zs(ss, keep), zt = zs(st, keep);
    const best = {};
    keep.forEach(i => { const id = meta.ids[i]; if (!byImg[id]) return; const z = 0.4 * zp(i) + 0.25 * zk(i) + 0.35 * zt(i);
      const k = famOf[id] || id; if (!best[k] || z > best[k].z) best[k] = { id, z }; });
    const ranked = Object.values(best).sort((a, b) => b.z - a.z).slice(0, 8);
    const label = z => z >= 2.5 ? "strong match" : z >= 1.6 ? "likely" : "possible";
    say(`Closest drawings${model ? " in " + esc(model) : ""} by shape, best first. Photo matching is a guide, so check the drawing before you order. Tip: photograph the part alone on a plain background, and choose its model first for better results.`);
    $("#matches").innerHTML = ranked.map(m => card({ id: m.id, confidence: m.z >= 2.5 ? "high" : "low", reason: "" }, label(m.z))).join("");
  } catch (err) {
    console.error(err);
    say("Photo search could not start. Check your internet connection and try again. It needs a recent Chrome, Edge or Safari.");
  }
};
