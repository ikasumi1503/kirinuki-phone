// スマホのページの一覧（パソコンの「保存した動画」と同じ並べ方）。
// 「切り抜きアシスタント」フォルダの動画を、カードで並べる。フォルダの札・名前で探す・期間・並べ替え。
// カードを押すと、そこから縦スワイプで続けて見られる（見る画面は phone.js の phViewer）。
// サムネイルは、動画を流す係（sw.js）で少しだけ読んで 1 コマを取り、この端末に覚える（IndexedDB。次からは読まない）。
// phone.js の phAll・phFolder・phToken・phStreamOk・phViewer を使う（読み込み順は index.html）

let phQuery = "";
let phSort = "new"; // new | old | name | size
let phPeriod = "all"; // all | day | week | month
let phLikes = null; // お気に入り（パソコンで付けたもの）の動画の id の Set。無ければ null（札を出さない）
let phLikesOnly = false;

const phNorm = (s) => String(s || "").normalize("NFKC").toLowerCase();
const phFmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const phFmtDur = (sec) => {
  if (!isFinite(sec) || sec <= 0) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};
const phFolderName = (id) => (id === "none" ? "" : (phAll.folders.find((x) => x.id === id) || {}).name || "");
const phTitleOf = (f) => String(f.name || "").replace(/\.[^.]+$/, "");

// いまの絞り込み・並べ替えで見える動画
function phVisible() {
  const q = phNorm(phQuery).trim();
  const now = Date.now();
  const span = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 }[phPeriod] || 0;
  let list = (phFolder === "all" ? phAll.files : phAll.files.filter((x) => x.folder === phFolder)).filter((f) => {
    if (phLikesOnly && !(phLikes && phLikes.has(f.id))) return false;
    if (span && now - new Date(f.createdTime).getTime() > span) return false;
    if (q && !phNorm(`${phTitleOf(f)} ${phFolderName(f.folder)}`).includes(q)) return false;
    return true;
  });
  const by = {
    new: (a, b) => (a.createdTime < b.createdTime ? 1 : -1),
    old: (a, b) => (a.createdTime > b.createdTime ? 1 : -1),
    name: (a, b) => phTitleOf(a).localeCompare(phTitleOf(b), "ja", { numeric: true }),
    size: (a, b) => (Number(b.size) || 0) - (Number(a.size) || 0),
  }[phSort];
  list = list.slice().sort(by);
  return list;
}

// ---- サムネイル（1 コマ）。この端末に覚える ----
const PH_THUMB_DB = "kiriPhoneThumbs";
let phThumbDb = null;
function phThumbOpen() {
  if (!phThumbDb)
    phThumbDb = new Promise((resolve) => {
      // 開くのを待ちすぎない（返事が来ないと、サムネイルが 1 つも出なくなる）。2 秒で諦めて、覚えずに作る
      const t = setTimeout(() => resolve(null), 2000);
      try {
        const r = indexedDB.open(PH_THUMB_DB, 1);
        r.onupgradeneeded = () => r.result.createObjectStore("t");
        r.onsuccess = () => (clearTimeout(t), resolve(r.result));
        r.onerror = () => (clearTimeout(t), resolve(null));
        r.onblocked = () => (clearTimeout(t), resolve(null));
      } catch {
        clearTimeout(t);
        resolve(null);
      }
    });
  return phThumbDb;
}
const phThumbKey = (f) => `${f.id}|${f.size || 0}`;
async function phThumbGet(f) {
  const db = await phThumbOpen();
  if (!db) return null;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 2000);
    try {
      const q = db.transaction("t").objectStore("t").get(phThumbKey(f));
      q.onsuccess = () => (clearTimeout(t), resolve(q.result || null));
      q.onerror = () => (clearTimeout(t), resolve(null));
    } catch {
      clearTimeout(t);
      resolve(null);
    }
  });
}
async function phThumbPut(f, v) {
  const db = await phThumbOpen();
  if (!db) return;
  try {
    db.transaction("t", "readwrite").objectStore("t").put(v, phThumbKey(f));
  } catch {}
}

// 動画から 1 コマ取る。流す係（./stream/）が動いていないとき・読めなかったときは null
const phStreamUrl = (f) => `./stream/${encodeURIComponent(f.id)}?t=${encodeURIComponent(phToken)}&s=${Number(f.size) || 0}${PH_TEST_API ? `&api=${encodeURIComponent(PH_TEST_API)}` : ""}`;
async function phMakeThumb(f) {
  if (!(await phStreamReady()) || !phToken) return null;
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "metadata"; // 動かして 1 コマ取るだけ。先を全部読み込まない（見る画面の読み込みを邪魔しない）
  v.className = "ph-tv";
  v.setAttribute("playsinline", "");
  v.setAttribute("muted", "");
  Object.assign(v.style, { position: "fixed", width: "2px", height: "2px", opacity: "0", pointerEvents: "none", left: "0", top: "0" });
  document.body.append(v);
  const until = (ev, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${ev} が来ない`)), ms);
      v.addEventListener(ev, () => (clearTimeout(t), resolve()), { once: true });
      v.addEventListener("error", () => (clearTimeout(t), reject(new Error("読めない"))), { once: true });
      v.addEventListener("emptied", () => (clearTimeout(t), reject(new Error("やめた"))), { once: true }); // phThumbStop で片付けられた
    });
  try {
    v.src = phStreamUrl(f);
    await until("loadeddata", 25000);
    const dur = v.duration;
    // 少し進んだ所（頭は黒いことが多い）。短い動画は真ん中あたり
    const at = isFinite(dur) && dur > 0 ? Math.min(Math.max(dur * 0.08, 0.5), 8, dur * 0.5) : 0.5;
    v.currentTime = at;
    await until("seeked", 25000);
    // iPhone は、動かした直後の絵が描けないことがある（黒く出る）。少し待って、描けなければ一瞬だけ再生する
    await new Promise((r) => setTimeout(r, 250));
    const draw = () => {
      const w = 320;
      const h = Math.max(1, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(v, 0, 0, w, h);
      const px = c.getContext("2d").getImageData(0, 0, w, h).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 400) sum += px[i] + px[i + 1] + px[i + 2];
      return { img: c.toDataURL("image/jpeg", 0.7), dark: sum / (px.length / 400) < 12, w: v.videoWidth, h: v.videoHeight };
    };
    let r = draw();
    if (r.dark) {
      try {
        await v.play();
        await new Promise((res) => setTimeout(res, 400));
        v.pause();
        r = draw();
      } catch {}
    }
    return { img: r.img, dur: isFinite(dur) ? dur : 0, w: r.w, h: r.h };
  } catch (e) {
    phThumbErrs.push(`${f.id}: ${(e && e.message) || e}`);
    if (phThumbErrs.length > 8) phThumbErrs.shift();
    return null;
  } finally {
    v.removeAttribute("src");
    v.load();
    v.remove();
  }
}

// 1 度に 2 本まで（スマホで何本も同時に読まない）
const phThumbQueue = [];
const phThumbErrs = []; // サムネイルが作れなかった理由（診断に入れる）
let phThumbBusy = 0;
function phThumbPump() {
  while (phThumbBusy < 2 && phThumbQueue.length) {
    const job = phThumbQueue.shift();
    phThumbBusy++;
    job().finally(() => {
      phThumbBusy--;
      phThumbPump();
    });
  }
}
let phThumbGen = 0; // 一覧を描き直したら上がる（古い一覧のためのサムネイルは作らない）
// 見る画面を開くとき: サムネイル作りは全部やめる（動画の読み込みを邪魔しない）。閉じたら、無いものだけ作り直す
function phThumbStop() {
  phThumbGen++;
  phThumbQueue.length = 0;
  for (const v of document.querySelectorAll("video.ph-tv")) {
    v.removeAttribute("src");
    v.load();
  }
}
function phThumbResume() {
  for (const li of document.querySelectorAll(".ph-card")) if (li.__f && !li.querySelector(".ph-img.on")) phThumbLoad(li.__f, li);
}
function phThumbLoad(f, li) {
  const gen = phThumbGen;
  const paint = (v) => {
    if (!v || !li.isConnected) return;
    const img = li.querySelector(".ph-img");
    img.src = v.img;
    img.classList.add("on");
    if (v.dur) {
      const b = li.querySelector(".ph-dur");
      b.textContent = phFmtDur(v.dur);
      b.hidden = false;
    }
    if (v.w && v.h && v.h > v.w) li.querySelector(".ph-thumb").classList.add("vertical");
  };
  phThumbGet(f).then((got) => {
    if (got) return paint(got);
    phThumbQueue.push(async () => {
      if (gen !== phThumbGen || !li.isConnected) return;
      const v = await phMakeThumb(f);
      if (v) {
        phThumbPut(f, v);
        paint(v);
      }
    });
    phThumbPump();
  });
}

// ---- 一覧 ----
function phLibRender() {
  document.getElementById("start").hidden = true;
  document.getElementById("lib").hidden = false;
  phThumbGen++;
  phThumbQueue.length = 0;
  const grid = document.getElementById("grid");
  const empty = document.getElementById("lib-empty");
  const list = phVisible();
  const total = list.reduce((n, f) => n + (Number(f.size) || 0), 0);
  document.getElementById("lib-stats").textContent = `${list.length} 本${total ? `・${phFmtSize(total)}` : ""}`;
  grid.replaceChildren();
  empty.hidden = !!list.length;
  empty.replaceChildren();
  if (!list.length) {
    if (!phAll.files.length) phEmptyBox(empty);
    else empty.append(Object.assign(document.createElement("p"), { textContent: phQuery || phPeriod !== "all" || phLikesOnly ? "合う動画がありません。" : "このフォルダには動画がありません。" }));
    return;
  }
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (io.unobserve(e.target), phThumbLoad(e.target.__f, e.target))), { rootMargin: "300px" }) : null;
  list.forEach((f, i) => {
    const li = document.createElement("li");
    li.className = "ph-card";
    li.__f = f;
    const fo = phFolderName(f.folder);
    li.innerHTML =
      '<button type="button" class="ph-thumb" aria-label="見る"><img class="ph-img" alt="" draggable="false"><span class="ph-play">▶</span><span class="ph-dur" hidden></span><span class="ph-heart" hidden>♥</span></button>' +
      '<div class="ph-name"></div><div class="ph-meta"></div>';
    li.querySelector(".ph-name").textContent = phTitleOf(f);
    li.querySelector(".ph-meta").textContent = [new Date(f.createdTime).toLocaleDateString("ja-JP"), f.size ? phFmtSize(Number(f.size)) : "", fo].filter(Boolean).join("・");
    if (phLikes && phLikes.has(f.id)) li.querySelector(".ph-heart").hidden = false;
    li.querySelector(".ph-thumb").addEventListener("click", () => phOpenViewer(list, i));
    grid.append(li);
    if (io) io.observe(li);
    else phThumbLoad(f, li);
  });
}

// ---- 見る画面（カードを押すと、そこから縦スワイプ）----
function phOpenViewer(list, index) {
  phPerf.openAt = performance.now();
  phPerf.firstPlayMs = null;
  phThumbStop();
  document.getElementById("viewer").hidden = false;
  document.body.classList.add("ph-viewing");
  history.pushState({ viewer: true }, "");
  phView = phViewer(list, index);
}
function phCloseViewer(fromHistory) {
  if (document.getElementById("viewer").hidden) return;
  if (phView) phView.destroy();
  phView = null;
  document.getElementById("viewer").hidden = true;
  document.body.classList.remove("ph-viewing");
  phThumbResume();
  if (!fromHistory && history.state && history.state.viewer) history.back();
}
document.getElementById("viewer-close").addEventListener("click", () => phCloseViewer(false));
window.addEventListener("popstate", () => phCloseViewer(true));

// ---- 探す・並べ替え・期間 ----
document.getElementById("q").addEventListener("input", (e) => {
  phQuery = e.target.value;
  phLibRender();
});
document.getElementById("sort").addEventListener("change", (e) => {
  phSort = e.target.value;
  phLibRender();
});
document.getElementById("period").addEventListener("change", (e) => {
  phPeriod = e.target.value;
  phLibRender();
});
