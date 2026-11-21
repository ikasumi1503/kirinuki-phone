// ---- MPEG-TS（.ts）を MP4 に詰め替える（画質は変わらない。入れ物だけ替える） ----
// ブラウザは .ts をそのまま再生できないので、vendor/mux.min.js（mux.js、Apache-2.0）で MP4 にする。
// 映像は H.264、音声は AAC の .ts だけ（ほとんどの配信の .ts はこれ）

const isTsName = (f) => /\.ts$/i.test(f.name || "") || /mp2t/i.test(f.type || "");
const mp4Name = (name) => String(name || "video").replace(/\.(ts|m2ts|mts|mp4)$/i, "") + ".mp4";

async function tsToMp4(blob, onProgress = () => {}) {
  if (typeof muxjs === "undefined") throw new Error("変換の部品が読み込めていません");
  const tm = new muxjs.mp4.Transmuxer({ remux: true, keepOriginalTimestamps: false });
  let init = null;
  const parts = [];
  const done = new Promise((resolve) => tm.on("done", resolve));
  tm.on("data", (seg) => {
    if (!init && seg.initSegment && seg.initSegment.byteLength) init = seg.initSegment;
    if (seg.data && seg.data.byteLength) parts.push(seg.data);
  });
  const CH = 188 * 8192; // 約 1.5MB ずつ（188 バイトの区切りに合わせる）
  for (let o = 0; o < blob.size; o += CH) {
    tm.push(new Uint8Array(await blob.slice(o, o + CH).arrayBuffer()));
    onProgress(Math.min(0.95, (o + CH) / blob.size));
  }
  tm.flush();
  await done;
  if (!init || !parts.length) throw new Error("映像を取り出せませんでした（H.264 以外の .ts かもしれません）");
  onProgress(1);
  // mux.js は長さの欄に「わからない」（0xFFFFFFFF）を入れるので、ブラウザが 13 時間 15 分の動画だと思う。本当の長さを書く
  return fmp4FixDuration(new Blob([init, ...parts], { type: "video/mp4" }));
}

// ---- 少しずつ流す形の MP4（fragmented）の、長さの欄を本当の長さにする ----
// 中身（moof の trun）のコマの長さを足して、mvhd・tkhd・mdhd・mehd の長さに書く。大きさは変わらない（同じ所を書き換えるだけ）。
// 直す要らないもの（moof が無い・もう正しい長さ）は、そのまま返す。fixed: 書き換えたか
const FMP4_UNKNOWN = 0xffffffff;
async function fmp4Inspect(blob) {
  const u32 = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const typ = (u8, o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  const kids = (u8, s, e) => {
    const out = [];
    for (let o = s; o + 8 <= e; ) {
      let size = u32(u8, o);
      let head = 8;
      if (size === 1) {
        size = u32(u8, o + 8) * 2 ** 32 + u32(u8, o + 12);
        head = 16;
      }
      if (size < 8 || o + size > e) break;
      out.push({ t: typ(u8, o + 4), at: o, s: o + head, e: o + size });
      o += size;
    }
    return out;
  };
  let moov = null;
  let moovAt = 0;
  const moovs = []; // 途中で入れ物の頭（init）が入れ直されると、moov が 2 つ以上ある。{ moov, at }
  const sums = new Map(); // track_ID → 足したコマの長さ（トラックの時間の単位）
  const noDur = new Map(); // track_ID → 長さが書かれていないコマの数（あとで moov の trex の決まった長さを掛ける）
  let at = 0;
  while (at + 8 <= blob.size) {
    const h = new Uint8Array(await blob.slice(at, at + 16).arrayBuffer());
    let size = u32(h, 0);
    if (size === 1) size = u32(h, 8) * 2 ** 32 + u32(h, 12);
    else if (size === 0) size = blob.size - at;
    if (size < 8) break;
    const t = typ(h, 4);
    if (t === "moov" && size < 64 * 1024 * 1024) {
      // 再生するもの・fmp4HeadBad が読むのは頭の moov。全部覚えて、全部直す
      moovs.push({ moov: new Uint8Array(await blob.slice(at, at + size).arrayBuffer()), at });
      if (!moov) {
        moov = moovs[0].moov;
        moovAt = at;
      }
    } else if (t === "moof" && size < 16 * 1024 * 1024) {
      const m = new Uint8Array(await blob.slice(at, at + size).arrayBuffer());
      for (const traf of kids(m, 8, m.length).filter((b) => b.t === "traf")) {
        const tk = kids(m, traf.s, traf.e);
        const tfhd = tk.find((b) => b.t === "tfhd");
        if (!tfhd) continue;
        const ff = u32(m, tfhd.s) & 0xffffff;
        const id = u32(m, tfhd.s + 4);
        let o = tfhd.s + 8;
        if (ff & 0x1) o += 8;
        if (ff & 0x2) o += 4;
        const defDur = ff & 0x8 ? u32(m, o) : 0;
        let total = 0;
        let missing = 0;
        for (const trun of tk.filter((b) => b.t === "trun")) {
          const tf = u32(m, trun.s) & 0xffffff;
          const n = u32(m, trun.s + 4);
          let p = trun.s + 8 + (tf & 0x1 ? 4 : 0) + (tf & 0x4 ? 4 : 0);
          const step = (tf & 0x100 ? 4 : 0) + (tf & 0x200 ? 4 : 0) + (tf & 0x400 ? 4 : 0) + (tf & 0x800 ? 4 : 0);
          if (tf & 0x100) for (let i = 0; i < n; i++, p += step) total += u32(m, p);
          else if (defDur) total += n * defDur;
          else missing += n;
        }
        sums.set(id, (sums.get(id) || 0) + total);
        if (missing) noDur.set(id, (noDur.get(id) || 0) + missing);
      }
    }
    at += size;
  }
  if (!moov) return { moov: null };
  // tfhd にも trun にもコマの長さが無いものは、moov の mvex の trex にある決まった長さ（default_sample_duration）を使う
  if (noDur.size) {
    const trexDur = new Map();
    for (const { moov: mo } of moovs) {
      const mvex = kids(mo, 8, mo.length).find((b) => b.t === "mvex");
      if (!mvex) continue;
      for (const trex of kids(mo, mvex.s, mvex.e).filter((b) => b.t === "trex")) {
        if (trex.e - trex.s < 16) continue;
        const tid = u32(mo, trex.s + 4);
        if (!trexDur.has(tid)) trexDur.set(tid, u32(mo, trex.s + 12));
      }
    }
    for (const [tid, n] of noDur) sums.set(tid, (sums.get(tid) || 0) + n * (trexDur.get(tid) || 0));
  }
  const mv = kids(moov, 8, moov.length);
  const mvhd = mv.find((b) => b.t === "mvhd");
  const v = moov[mvhd.s];
  const movieTs = u32(moov, mvhd.s + (v === 1 ? 20 : 12));
  const movieDur = v === 1 ? u32(moov, mvhd.s + 24) * 2 ** 32 + u32(moov, mvhd.s + 28) : u32(moov, mvhd.s + 16);
  return { moov, moovAt, moovs, kids, u32, mv, mvhd, movieTs, movieDur, sums };
}

async function fmp4FixDuration(blob) {
  const x = await fmp4Inspect(blob).catch(() => ({ moov: null }));
  if (!x.moov || !x.sums.size) return blob; // 少しずつ流す形でない（ふつうの MP4）
  // コマの長さが 1 つもわからない（足すと 0）なら、0 を書いても直らないので、そのまま返す
  if (![...x.sums.values()].some((n) => n > 0)) return blob;
  let changed = false;
  for (const { moov } of x.moovs) if (fmp4PatchMoov(moov, x)) changed = true;
  if (!changed) return blob; // もう正しい長さだった
  // 書き換えた moov（大きさは同じ）を元の場所にはめ直す
  const parts = [];
  let from = 0;
  for (const { moov, at } of x.moovs) {
    parts.push(blob.slice(from, at), moov);
    from = at + moov.length;
  }
  parts.push(blob.slice(from));
  return new Blob(parts, { type: blob.type || "video/mp4" });
}

// 1 つの moov の長さの欄を、足したコマの長さで書き換える（その場で。大きさは変わらない）。書き換えたら true
function fmp4PatchMoov(moov, x) {
  const { kids, u32 } = x;
  const mv = kids(moov, 8, moov.length);
  const mvhd = mv.find((b) => b.t === "mvhd");
  if (!mvhd) return false;
  const movieTs = u32(moov, mvhd.s + (moov[mvhd.s] === 1 ? 20 : 12));
  let changed = false;
  const put32 = (o, n) => {
    const b = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    for (let i = 0; i < 4; i++) {
      if (moov[o + i] !== b[i]) changed = true;
      moov[o + i] = b[i];
    }
  };
  // 長さの欄（版 0 は 32 ビット、版 1 は 64 ビット）
  const putDur = (o, version, n) => {
    if (version === 1) {
      put32(o, Math.floor(n / 2 ** 32));
      put32(o + 4, n >>> 0);
    } else put32(o, Math.min(n, FMP4_UNKNOWN - 1));
  };
  let longest = 0;
  const trakDur = new Map(); // track_ID → 秒
  for (const trak of mv.filter((b) => b.t === "trak")) {
    const tk = kids(moov, trak.s, trak.e);
    const tkhd = tk.find((b) => b.t === "tkhd");
    const tv = moov[tkhd.s];
    const id = u32(moov, tkhd.s + (tv === 1 ? 20 : 12));
    const mdia = tk.find((b) => b.t === "mdia");
    const mdhd = kids(moov, mdia.s, mdia.e).find((b) => b.t === "mdhd");
    const mv2 = moov[mdhd.s];
    const ts = u32(moov, mdhd.s + (mv2 === 1 ? 20 : 12));
    const sum = x.sums.get(id) || 0;
    if (!ts) continue;
    putDur(mdhd.s + (mv2 === 1 ? 24 : 16), mv2, sum);
    const sec = sum / ts;
    trakDur.set(id, { sec, tkhd, tv });
    longest = Math.max(longest, sec);
  }
  for (const { sec, tkhd, tv } of trakDur.values()) putDur(tkhd.s + (tv === 1 ? 28 : 20), tv, Math.round(sec * movieTs));
  const v = moov[mvhd.s];
  putDur(mvhd.s + (v === 1 ? 24 : 16), v, Math.round(longest * movieTs));
  const mvex = mv.find((b) => b.t === "mvex");
  const mehd = mvex && kids(moov, mvex.s, mvex.e).find((b) => b.t === "mehd");
  if (mehd) putDur(mehd.s + 4, moov[mehd.s], Math.round(longest * movieTs));
  return changed;
}

// ファイルの頭（数 KB）だけで見分ける: 頭に moov があり、mvex（少しずつ流す形の印）を持ち、長さが「わからない」か 0
function fmp4HeadBad(u8) {
  const u32 = (o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const typ = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  for (let o = 0; o + 8 <= u8.length; ) {
    const size = u32(o);
    if (size < 8) return false;
    if (typ(o + 4) === "moov") {
      const end = Math.min(u8.length, o + size);
      let mvhd = -1;
      let mvex = false;
      for (let p = o + 8; p + 8 <= end; ) {
        const s = u32(p);
        if (s < 8) break;
        if (typ(p + 4) === "mvhd") mvhd = p + 8;
        if (typ(p + 4) === "mvex") mvex = true;
        p += s;
      }
      if (mvhd < 0 || !mvex) return false;
      const dur = u8[mvhd] === 1 ? u32(mvhd + 24) * 2 ** 32 + u32(mvhd + 28) : u32(mvhd + 16);
      return dur >= FMP4_UNKNOWN || dur === 0;
    }
    o += size;
  }
  return false;
}

// 長さの欄が「わからない」（13 時間 15 分などに見える）少しずつ流す形の MP4 か
async function fmp4BadDuration(blob) {
  const x = await fmp4Inspect(blob).catch(() => ({ moov: null }));
  return !!(x.moov && x.sums.size && (x.movieDur >= FMP4_UNKNOWN || x.movieDur === 0));
}
