// Admin saving for the free site: stands in for the claude.ai storage the main site uses.
// Added drawings and deletions are saved as files in the GitHub repo (data/*.json, files/*),
// using a GitHub key that the admin enters once on their own device.
(function () {
  const OWNER = "vijay158199", REPO = "Vermeiren-", BRANCH = "main";
  const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/`;
  const KEY = "vdf.ghkey";
  const token = () => { try { return localStorage.getItem(KEY) || ""; } catch (_) { return ""; } };
  const signedIn = () => { try { return sessionStorage.getItem("vdf.adm") === "1"; } catch (_) { return false; } };
  const hdr = () => ({ Authorization: "Bearer " + token(), Accept: "application/vnd.github+json" });
  const fail = (code, message) => Object.assign(new Error(message || code), { code });

  // Files uploaded in this visit are shown from memory until GitHub Pages has published them
  const local = {};
  window.__blob = id => local[id] || "files/" + id;

  const b64 = blob => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = no; r.readAsDataURL(blob); });
  const utf8b64 = s => { const b = new TextEncoder().encode(s); let t = ""; for (let i = 0; i < b.length; i += 0x8000) t += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(t); };
  const fromb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), c => c.charCodeAt(0)));

  let queue = Promise.resolve();
  const serial = fn => (queue = queue.then(fn, fn));

  async function getFile(path) {
    const r = await fetch(API + path + "?ref=" + BRANCH + "&t=" + Date.now(), { headers: hdr(), cache: "no-store" });
    if (r.status === 404) return null;
    if (r.status === 401) throw fail("upstream_auth", "GitHub key not accepted");
    if (!r.ok) throw fail("upstream_error", "GitHub " + r.status);
    return r.json();
  }
  async function putFile(path, content, sha, message) {
    const r = await fetch(API + path, { method: "PUT", headers: hdr(), body: JSON.stringify({ message, content, branch: BRANCH, ...(sha ? { sha } : {}) }) });
    if (r.status === 401 || r.status === 403) throw fail("not_granted", "GitHub key cannot write");
    if (r.status === 409 || r.status === 422) throw fail("conflict", "GitHub " + r.status);
    if (!r.ok) throw fail("upstream_error", "GitHub " + r.status);
    return r.json();
  }
  async function delFile(path, message) {
    const f = await getFile(path); if (!f) return false;
    const r = await fetch(API + path, { method: "DELETE", headers: hdr(), body: JSON.stringify({ message, sha: f.sha, branch: BRANCH }) });
    if (!r.ok) throw fail("upstream_error", "GitHub " + r.status);
    return true;
  }

  // ---- collections: data/<name>.json holds an array of {_id, ...fields} ----
  const cache = {}, subs = {};
  async function readColl(name) {
    if (token() && signedIn()) { const f = await getFile("data/" + name + ".json"); return f ? JSON.parse(fromb64(f.content)) : []; }
    const r = await fetch("data/" + name + ".json?t=" + Date.now(), { cache: "no-store" });
    return r.ok ? r.json() : [];
  }
  const emit = name => (subs[name] || []).forEach(cb => cb({ docs: (cache[name] || []).map(d => { const { _id, ...v } = d; return { id: _id, data: () => v }; }) }));
  function change(name, fn, what) {
    return serial(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const f = await getFile("data/" + name + ".json");
        const rows = f ? JSON.parse(fromb64(f.content)) : [];
        const next = fn(rows);
        try { await putFile("data/" + name + ".json", utf8b64(JSON.stringify(next, null, 1) + "\n"), f && f.sha, what); cache[name] = next; emit(name); return; }
        catch (e) { if (e.code !== "conflict") throw e; }
      }
      throw fail("store_unavailable", "GitHub was busy, try again");
    });
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const docRef = (name, id) => ({
    id,
    set: data => change(name, rows => rows.filter(r => r._id !== id).concat([{ _id: id, ...data }]), `Admin: save ${name} ${data.drawing || id}`),
    delete: () => change(name, rows => rows.filter(r => r._id !== id), `Admin: remove ${name} ${id}`),
  });
  const db = {
    collection: name => ({
      onSnapshot(cb, err) {
        (subs[name] = subs[name] || []).push(cb);
        readColl(name).then(rows => { cache[name] = rows; emit(name); }).catch(e => err && err(e));
        return () => { subs[name] = subs[name].filter(x => x !== cb); };
      },
      add: async data => { const id = newId(); await docRef(name, id).set(data); return { id }; },
      doc: id => docRef(name, id),
    }),
    doc: path => { const [name, id] = path.split("/"); return docRef(name, id); },
  };

  const EXT = { "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" };
  const assets = {
    upload: (blob, opt) => serial(async () => {
      const type = (opt && opt.type) || blob.type, id = newId() + "." + (EXT[type] || "bin");
      await putFile("files/" + id, await b64(blob), null, "Admin: upload " + id);
      local[id] = URL.createObjectURL(blob);
      return { id, url: local[id], sizeBytes: blob.size, contentType: type };
    }),
    delete: id => serial(async () => ({ deleted: await delFile("files/" + id, "Admin: delete " + id) })),
    list: async () => ({ assets: [], usage: {} }),
  };

  const user = { canEdit: async () => !!token() && signedIn(), id: async () => "VijayT" };
  window.claude = { use: async cap => cap === "db" ? db : cap === "assets" ? (token() && signedIn() ? assets : null) : cap === "user" ? user : null };

  // ---- the GitHub key box on the Admin page ----
  async function check(k) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers: { Authorization: "Bearer " + k, Accept: "application/vnd.github+json" } });
    if (!r.ok) return "GitHub did not accept this key. Copy it again and paste it here.";
    const j = await r.json();
    return j.permissions && j.permissions.push ? "" : "This key can only read. Give it Contents: Read and write on the Vermeiren- repository.";
  }
  document.addEventListener("DOMContentLoaded", () => {
    const strip = document.getElementById("astrip"); if (!strip) return;
    const box = document.createElement("div");
    box.className = "awarn ghkey";
    if (!token()) {
      box.innerHTML = `<b>One-time setup on this phone:</b> paste your GitHub key so the Admin page can save to the website.
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input id="ghk" type="password" autocomplete="off" placeholder="github_pat_…" style="flex:1;min-width:200px;padding:9px 10px;border-radius:10px;border:1px solid var(--line,#ccc);font:inherit">
        <button type="button" class="btn" id="ghs">Save key</button></div><div id="ghe" style="margin-top:6px"></div>`;
      strip.after(box);
      box.querySelector("#ghs").onclick = async () => {
        const k = box.querySelector("#ghk").value.trim(), e = box.querySelector("#ghe");
        if (!k) return; e.textContent = "Checking the key…";
        const bad = await check(k).catch(() => "Could not reach GitHub. Check the internet connection.");
        if (bad) { e.textContent = bad; return; }
        try { localStorage.setItem(KEY, k); } catch (_) {}
        location.hash = "#admin"; location.reload();
      };
    } else {
      box.style.borderStyle = "dashed";
      box.innerHTML = `Changes save to GitHub and show for everyone within a minute or two. <a href="#admin" id="ghf">Remove the GitHub key from this phone</a>`;
      strip.after(box);
      box.querySelector("#ghf").onclick = ev => { ev.preventDefault(); try { localStorage.removeItem(KEY); } catch (_) {} location.reload(); };
    }
    const sync = () => { box.hidden = strip.hidden; };
    new MutationObserver(sync).observe(strip, { attributes: true, attributeFilter: ["hidden"] }); sync();
  });
})();
