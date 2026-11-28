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
  v.preload = "auto";
  v.className = "ph-tv";
  v.setAttribute("playsinline", "");
  v.setAttribute("muted", "");
  Object.assign(v.style, { position: "fixed", width: "2px", height: "2px", opacity: "0", pointerEvents: "none", left: "0", top: "0" });
  document.body.append(v);
  let stage = "始め";
  const until = (ev, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${ev} が来ない（${stage}）`)), ms);
      v.addEventListener(ev, () => (clearTimeout(t), resolve()), { once: true });
      v.addEventListener("error", () => (clearTimeout(t), reject(new Error(`読めない（${stage}）`))), { once: true });
      v.addEventListener("emptied", () => (clearTimeout(t), reject(new Error("やめた"))), { once: true }); // phThumbStop で片付けられた
    });
  const draw = () => {
    const w = 320;
    const h = Math.max(1, Math.round((w * v.videoHeight) / Math.max(1, v.videoWidth)));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    g.drawImage(v, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    let sum = 0;
    for (let k = 0; k < px.length; k += 400) sum += px[k] + px[k + 1] + px[k + 2];
    return { img: c.toDataURL("image/jpeg", 0.7), dark: sum / (px.length / 400) < 12, w: v.videoWidth, h: v.videoHeight };
  };
  try {
    v.src = phStreamUrl(f);
    // iPhone は、再生を始めるまで loadeddata を出さないことがある（診断で、サムネイル 6 本が全部これで失敗した）。目次が読めたら先へ進む
    stage = "目次";
    await until("loadedmetadata", 20000);
    const dur = v.duration;
    // 少し進んだ所（頭は黒いことが多い）。短い動画は真ん中あたり
    const at = isFinite(dur) && dur > 0 ? Math.min(Math.max(dur * 0.08, 0.5), 8, dur * 0.5) : 0.5;
    stage = "動かす";
    v.currentTime = at;
    // iPhone は、見えない動画では seeked を出さないことがある（診断で、サムネイル 8 本が全部これで失敗した）。
    // 待ちすぎず、先へ進む（絵が描けなければ、次で一瞬だけ再生して取る）。読めない・やめたときだけ失敗にする
    await until("seeked", 4000).catch((e) => {
      if (/やめた|読めない/.test(String(e && e.message))) throw e;
    });
    await new Promise((r) => setTimeout(r, 300));
    let r = null;
    try {
      r = v.readyState >= 2 ? draw() : null;
    } catch {}
    if (!r || r.dark) {
      // 描けない・黒い: 音なしで一瞬だけ再生して、絵が出るのを待つ（iPhone は、動かしただけでは絵を出さないことがある）
      stage = "再生";
      await v.play();
      await Promise.race([new Promise((res) => (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => res()) : setTimeout(res, 800))), new Promise((res) => setTimeout(res, 5000))]);
      v.pause();
      r = draw();
    }
    if (r.dark && at > 0.6) throw new Error("黒い絵しか出ない");
    return { img: r.img, dur: isFinite(dur) ? dur : 0, w: r.w, h: r.h };
  } catch (e) {
    phThumbErrs.push(`${f.id.slice(0, 8)}: ${(e && e.message) || e}`);
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

// ---- 動画の目次の準備（裏で）----
// 初めて開く動画は、目次を読むのに通信の往復が 4〜5 回かかる（1 回 0.6〜1 秒。3〜4 秒待つ）。
// 一覧が出たら、流す係に頼んで、見えている動画の目次を先に読んでおいてもらう（覚えておくので、押したときはすぐ始まる）
const phWarmed = new Set();
async function phWarm(list) {
  if (!navigator.serviceWorker || !phToken || !(await phStreamReady()) || !navigator.serviceWorker.controller) return;
  const items = list
    .slice(0, 40)
    .filter((f) => !phWarmed.has(f.id))
    .map((f) => ({ id: f.id, size: Number(f.size) || 0, token: phToken, api: PH_TEST_API }));
  for (const it of items) phWarmed.add(it.id);
  if (items.length) navigator.serviceWorker.controller.postMessage({ type: "warm", items });
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
  phWarm(list).catch(() => {});
  const io = "IntersectionObserver" in window ? new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (io.unobserve(e.target), phThumbLoad(e.target.__f, e.target))), { rootMargin: "300px" }) : null;
  list.forEach((f, i) => {
    const li = document.createElement("li");
    li.className = "ph-card";
    li.__f = f;
    const fo = phFolderName(f.folder);
    li.innerHTML =
      '<button type="button" class="ph-thumb" aria-label="見る"><img class="ph-img" alt="" draggable="false"><span class="ph-play">▶</span><span class="ph-dur" hidden></span></button>' +
      '<button type="button" class="ph-heart" aria-label="お気に入り" aria-pressed="false">♡</button>' +
      '<div class="ph-name"></div><div class="ph-meta"></div>';
    li.querySelector(".ph-name").textContent = phTitleOf(f);
    li.querySelector(".ph-meta").textContent = [new Date(f.createdTime).toLocaleDateString("ja-JP"), f.size ? phFmtSize(Number(f.size)) : "", fo].filter(Boolean).join("・");
    const heart = li.querySelector(".ph-heart");
    if (phLikes && phLikes.has(f.id)) {
      heart.textContent = "♥";
      heart.classList.add("on");
      heart.setAttribute("aria-pressed", "true");
    }
    heart.addEventListener("click", () => phSetLike(f.id, !(phLikes && phLikes.has(f.id))));
    li.querySelector(".ph-thumb").addEventListener("click", () => phOpenViewer(list, i));
    grid.append(li);
    if (io) io.observe(li);
    else phThumbLoad(f, li);
  });
}

// ---- 見る画面（カードを押すと、そこから縦スワイプ）----
function phOpenViewer(list, index) {
  // 目次の準備もやめる（見る動画の読み込みを邪魔しない）
  try {
    navigator.serviceWorker.controller.postMessage({ type: "warm-stop" });
  } catch {}
  phLog("open", { i: index, n: list.length, id: (list[index] && list[index].id || "").slice(0, 8) });
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
  if (typeof phHideDiagButton === "function") phHideDiagButton(30000); // 閉じたら、下の小さなボタンも消す
  phThumbResume();
  phWarmed.clear(); // 途中でやめた分も、もう一度頼む（覚えた分はすぐ済む）
  phWarm(phVisible()).catch(() => {});
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
