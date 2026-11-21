// スマホのページの「流す係」（サービスワーカー）。ドライブの動画を、全部読み込まずに、見ている所だけ少しずつ読んで流す。
// ページは動画を ./stream/<ファイルの id>?t=<鍵>&s=<動画の大きさ> として流す。ここがそれを受け取り、Google ドライブへ
// 「鍵を付けて・同じ範囲（Range）で」聞き直して、返ってきたものを渡す。
// - 前は動画を丸ごと（300 MB 以上）スマホの中に読み込んでから流していたので、スマホでは「再生できませんでした」になりやすかった
// - Google ドライブは、どこからどこまでの答えか（Content-Range）をページに見せない（見せるのは Content-Length などだけ）。
//   そのまま渡すと、範囲の答えなのに Content-Range が無く、スマホ（Safari は特に）は動画を流せない。
//   なので、頼んだ範囲・返ってきた長さ・動画の大きさ（s）から、ここで Content-Range を付け直す
// - 鍵はこのページの中だけで使う（./stream/ はここで受け取り、外へは出さない。ページは、この係が動いているときだけ ./stream/ を使う）
const SW_API = "https://www.googleapis.com/drive/v3/files/";
importScripts("remux.js"); // 細かく分けて書かれた MP4（保存した動画の元の形）を、iPhone でも読める普通の形に、読みながら組み替える（remux.js）

// 流れの記録（直近 80 件）。止まる原因（ドライブの返事が遅い・流れが細い）を診断で見るため。動画の中身・名前・鍵は入れない
const swStats = [];
const swNote = (rec) => {
  swStats.push({ at: Date.now(), ...rec });
  if (swStats.length > 80) swStats.shift();
};
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "stats" && e.ports && e.ports[0]) e.ports[0].postMessage(swStats.slice());
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const m = url.pathname.match(/\/stream\/([A-Za-z0-9_-]+)$/);
  if (!m) return;
  // 確かめ用: 手元（localhost）で開いたときだけ、聞き先を手元の偽のドライブに替えられる
  const api = url.searchParams.get("api");
  const local = /^(localhost|127\.0\.0\.1)$/;
  const base = api && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(api) && local.test(self.location.hostname) ? api : SW_API;
  const size = Number(url.searchParams.get("s")) || 0;
  // 流している間、流す係を止められないようにする（iPhone は、動いていない流す係を止める。流している途中で止められると、動画が止まる）。
  // 流し終わる・やめる・失敗するまで、waitUntil で待つ
  let finish = () => {};
  e.waitUntil(new Promise((r) => (finish = r)));
  e.respondWith(swStream(e.request, m[1], url.searchParams.get("t") || "", base, size, finish));
});

// 流れの中身はそのまま渡して、終わったら finish を呼ぶ
function swTrack(body, finish, meta = {}) {
  const reader = body.getReader();
  const t0 = performance.now();
  let first = -1;
  let bytes = 0;
  let noted = false;
  const note = (end) => {
    if (noted) return;
    noted = true;
    swNote({ k: "resp", ...meta, firstMs: Math.round(first), ms: Math.round(performance.now() - t0), bytes, end });
  };
  return new ReadableStream({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          c.close();
          note("done");
          finish();
        } else {
          if (first < 0) first = performance.now() - t0;
          bytes += value.length;
          c.enqueue(value);
        }
      } catch (err) {
        c.error(err);
        note(`error ${(err && err.message) || err}`);
        finish();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
      note("cancel");
      finish();
    },
  });
}

// "bytes=10-" "bytes=10-99" → { start, end }（end は無ければ null）。読めない・複数の範囲は null
function swRange(h) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(h || "").trim());
  return m ? { start: Number(m[1]), end: m[2] === "" ? null : Number(m[2]) } : null;
}

// 動画ごとの、組み替えの設計図（ファイルの目次を読むのは 1 回だけ）。組み替えが要らない動画は null。
// 読めなかったとき（通信・ログインの期限）は残さない（次にまた読む）
const swLayouts = new Map();
// 設計図は IndexedDB にも覚える（流す係は、iPhone が止めるたびに作り直される。覚えておけば、2 回目からは目次を読み直さない）。
// 先頭（head）は 1 MB を超えることもあるが、動画 1 本ぶんなので覚える。覚えるのは、組み替えた設計図と「組み替え不要」だけ
let swDbP = null;
function swDb() {
  // IndexedDB が開くのを待ちすぎない（新しい環境で、開くのに時間がかかる・返事が来ないことがある）。1.5 秒で諦めて、覚えずに作る
  if (!swDbP)
    swDbP = new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 1500);
      try {
        const r = indexedDB.open("kiriSwLayouts", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("l");
        r.onsuccess = () => (clearTimeout(t), resolve(r.result));
        r.onerror = () => (clearTimeout(t), resolve(null));
        r.onblocked = () => (clearTimeout(t), resolve(null));
      } catch {
        clearTimeout(t);
        resolve(null);
      }
    });
  return swDbP;
}
async function swDbGet(key) {
  const db = await swDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), 1500);
    try {
      const q = db.transaction("l").objectStore("l").get(key);
      q.onsuccess = () => (clearTimeout(t), resolve(q.result));
      q.onerror = () => (clearTimeout(t), resolve(undefined));
    } catch {
      clearTimeout(t);
      resolve(undefined);
    }
  });
}
async function swDbPut(key, v) {
  const db = await swDb();
  if (!db) return;
  try {
    const tx = db.transaction("l", "readwrite");
    const os = tx.objectStore("l");
    os.put(v, key);
    // 古いものから消す（30 本まで）
    const ks = os.getAllKeys();
    ks.onsuccess = () => ks.result.length > 30 && ks.result.slice(0, ks.result.length - 30).forEach((k) => os.delete(k));
  } catch {}
}
function swLayout(id, token, base, size) {
  const key = `${id}|${size}`;
  if (!size) return Promise.resolve(null);
  if (!swLayouts.has(key)) {
    const read = async (o, n) => {
      const r = await fetch(`${base}${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: `Bearer ${token}`, Range: `bytes=${o}-${o + n - 1}` } });
      if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const p = swDbGet(key)
      .then(async (hit) => {
        if (hit === "none") return null;
        if (hit && hit.head && hit.segs) return hit;
        const built = await VdhRemux.remuxBuild(read, size);
        swDbPut(key, built || "none");
        return built;
      })
      .catch((e) => {
        swLayouts.delete(key);
        throw e;
      });
    swLayouts.set(key, p);
    if (swLayouts.size > 20) swLayouts.delete(swLayouts.keys().next().value);
  }
  return swLayouts.get(key);
}

// 元のファイルの範囲を、順に読んで 1 本の流れにする（head は、組み替えで作った先頭の部分をそのまま）
function swPiecesStream(pieces, open) {
  let i = 0;
  let reader = null;
  let cancelled = false;
  const pullOne = async (c) => {
    for (;;) {
      if (cancelled) return;
      if (!reader) {
        if (i >= pieces.length) return c.close();
        const p = pieces[i++];
        // 設計図の先頭は何度も使うので、写しを渡す（そのまま渡すと、読んだ側に取られて空になることがある）
        if (p.head) return c.enqueue(p.head.slice());
        reader = (await open(p.o, p.n)).getReader();
      }
      const { done, value } = await reader.read();
      if (cancelled) return;
      if (done) {
        reader = null;
        continue;
      }
      return c.enqueue(value);
    }
  };
  return new ReadableStream({
    async pull(c) {
      try {
        await pullOne(c);
      } catch (e) {
        if (cancelled) return; // 見ている側がやめたあとの失敗は、気にしない
        console.error("[sw] 流れが止まった", (e && e.message) || e);
        throw e;
      }
    },
    cancel() {
      cancelled = true;
      if (reader) reader.cancel().catch(() => {});
    },
  });
}

const layoutUsed = (r) => (r && r.__remux ? "remux" : "pass");

async function swStream(req, id, token, base, size, finish) {
  let r;
  try {
    r = await swStreamInner(req, id, token, base, size);
  } catch (err) {
    finish();
    return new Response(`sw ${(err && err.message) || err}`, { status: 502 });
  }
  if (!r.body) {
    finish();
    return r;
  }
  return new Response(swTrack(r.body, finish, { range: req.headers.get("range") || "", via: layoutUsed(r) }), { status: r.status, statusText: r.statusText, headers: r.headers });
}

async function swStreamInner(req, id, token, base = SW_API, size = 0) {
  const want = swRange(req.headers.get("range"));
  // 細かく分けて書かれた MP4 は、iPhone が読み解けない。普通の形に組み替えて流す
  let layout = null;
  try {
    layout = await swLayout(id, token, base, size);
  } catch (e) {
    return new Response("layout " + ((e && e.message) || e), { status: 502 });
  }
  if (layout) {
    const total = layout.size;
    const start = want ? want.start : 0;
    if (start >= total) return new Response("", { status: 416, headers: { "content-range": `bytes */${total}` } });
    const end = want && want.end != null ? Math.min(want.end, total - 1) : total - 1;
    const open = async (o, n) => {
      const t0 = performance.now();
      const r = await fetch(`${base}${encodeURIComponent(id)}?alt=media`, { headers: { Authorization: `Bearer ${token}`, Range: `bytes=${o}-${o + n - 1}` } });
      swNote({ k: "drive", o, n, status: r.status, ttfbMs: Math.round(performance.now() - t0) });
      if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
      return r.body;
    };
    const out = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": String(end - start + 1) });
    if (want) out.set("content-range", `bytes ${start}-${end}/${total}`);
    const resp = new Response(swPiecesStream(VdhRemux.remuxPieces(layout, start, end), open), { status: want ? 206 : 200, headers: out });
    resp.__remux = true;
    return resp;
  }
  // 動画の終わりより後ろを頼まれた（大きさがわかっているとき）
  if (want && size && want.start >= size) return new Response("", { status: 416, headers: { "content-range": `bytes */${size}` } });
  const headers = { Authorization: `Bearer ${token}` };
  if (want) headers.Range = `bytes=${want.start}-${want.end != null ? want.end : ""}`;
  let r;
  const t0 = performance.now();
  try {
    r = await fetch(`${base}${encodeURIComponent(id)}?alt=media`, { headers });
  } catch (e) {
    swNote({ k: "drive", range: headers.Range || "", status: "network error" });
    return new Response("network", { status: 502 });
  }
  swNote({ k: "drive", range: headers.Range || "", status: r.status, ttfbMs: Math.round(performance.now() - t0) });
  if (!r.ok) return new Response(`HTTP ${r.status}`, { status: r.status });
  const out = new Headers({ "content-type": r.headers.get("content-type") || "video/mp4", "accept-ranges": "bytes" });
  const len = Number(r.headers.get("content-length")) || 0;
  // 範囲で頼まなかった: 全部（大きさがわかれば付ける）
  if (!want) {
    if (len || size) out.set("content-length", String(len || size));
    return new Response(r.body, { status: 200, headers: out });
  }
  // 範囲の答え。Content-Range はドライブが見せてくれないので、ここで作る
  // （見せてくれたときはそれを使う。長さがわからないときは、頼んだ範囲と動画の大きさから決める）
  const given = r.headers.get("content-range");
  let total = size;
  let start = want.start;
  let end = null;
  const gm = given && /bytes (\d+)-(\d+)\/(\d+|\*)/.exec(given);
  if (gm) {
    start = Number(gm[1]);
    end = Number(gm[2]);
    if (gm[3] !== "*") total = Number(gm[3]);
  } else if (len) end = start + len - 1;
  else if (total) end = want.end != null ? Math.min(want.end, total - 1) : total - 1;
  // ドライブが範囲を見ずに全部を返した（200）: 頼まれた所だけを切り出して渡す
  if (r.status === 200) {
    total = total || len;
    end = want.end != null ? Math.min(want.end, total - 1) : total - 1;
    return new Response(swSlice(r.body, start, end - start + 1), {
      status: 206,
      headers: new Headers({ ...Object.fromEntries(out), "content-range": `bytes ${start}-${end}/${total || "*"}`, "content-length": String(end - start + 1) }),
    });
  }
  if (end == null) return new Response(r.body, { status: 206, headers: out }); // 決めようがない（ふつうは来ない）
  out.set("content-range", `bytes ${start}-${end}/${total || "*"}`);
  out.set("content-length", String(end - start + 1));
  return new Response(r.body, { status: 206, headers: out });
}

// 流れの中から、skip バイト飛ばして、n バイトだけを渡す
function swSlice(body, skip, n) {
  const reader = body.getReader();
  let left = n;
  return new ReadableStream({
    async pull(c) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || left <= 0) {
          reader.cancel().catch(() => {});
          return c.close();
        }
        let v = value;
        if (skip) {
          if (v.length <= skip) {
            skip -= v.length;
            continue;
          }
          v = v.subarray(skip);
          skip = 0;
        }
        if (v.length > left) v = v.subarray(0, left);
        left -= v.length;
        c.enqueue(v);
        if (left <= 0) {
          reader.cancel().catch(() => {});
          c.close();
        }
        return;
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}
