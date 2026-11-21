// 細かく分けて書かれた MP4（fragmented MP4。ts-mp4.js が作る、保存した動画の元の形）を、
// iPhone でも読める普通の MP4（目次 moov が先頭にあり、コマの表が全部入ったもの）に、読みながら組み替える。
//
// 前は、iPhone の診断で「動画の先頭も末尾も正しく届いているのに、映像を読み解けない（Media failed to decode）」だった。
// 保存した動画の元の形は、全部を 2 つほどの大きなかたまり（moof + mdat）で書いてあり、パソコンのブラウザは読めるが iPhone は読めない。
//
// 動画の中身（mdat の中の映像・音のバイト）はそのまま使う。組み替えるのは目次だけ:
//   仮のファイル = ftyp + 新しい moov（コマの表つき）+ mdat の見出し + [元の mdat の中身を順に並べたもの]
// ドライブには元のファイルの範囲を聞き直すだけなので、全部を読み込まない（何 GB でも、見ている所だけ）。
//
// remuxBuild(read, total) → { size, head, segs } | null（細かく分けて書かれていなければ null。そのまま流す）
//   read(offset, length) → Promise<Uint8Array>  元のファイルの範囲を読む
//   head = 仮のファイルの先頭（ftyp + moov + mdat の見出し）。segs = [{ o: 元の位置, n: 長さ, v: 仮のファイルでの位置 }]
// remuxPieces(layout, start, end) → [{ head: Uint8Array } | { o, n }]  仮のファイルの [start, end]（両端を含む）を、元の範囲に直す
const VdhRemux = (() => {
  const u32 = (u, o) => ((u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3]) >>> 0;
  const i32 = (u, o) => (u[o] << 24) | (u[o + 1] << 16) | (u[o + 2] << 8) | u[o + 3];
  const u64 = (u, o) => u32(u, o) * 4294967296 + u32(u, o + 4);
  const cc = (u, o) => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  const put32 = (u, o, n) => {
    u[o] = (n >>> 24) & 255;
    u[o + 1] = (n >>> 16) & 255;
    u[o + 2] = (n >>> 8) & 255;
    u[o + 3] = n & 255;
  };
  const put64 = (u, o, n) => {
    put32(u, o, Math.floor(n / 4294967296));
    put32(u, o + 4, n % 4294967296);
  };
  const concat = (parts) => {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const be32 = (n) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const box = (type, ...parts) => {
    const body = concat(parts);
    const out = new Uint8Array(8 + body.length);
    put32(out, 0, out.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    return out;
  };
  const full = (type, ver, flags, ...parts) => box(type, Uint8Array.of(ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);

  // u の [start, end) にある箱を順に（見出しだけ）返す
  function* kids(u, start = 0, end = u.length) {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(u, o);
      let hdr = 8;
      if (size === 1) {
        size = u64(u, o + 8);
        hdr = 16;
      } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) return;
      yield { type: cc(u, o + 4), start: o, size, data: o + hdr, end: o + size };
      o += size;
    }
  }
  const child = (u, b, type) => {
    for (const k of kids(u, b.data, b.end)) if (k.type === type) return k;
    return null;
  };

  // 元のファイルのいちばん外側の箱を、見出しだけ読んで並べる
  async function topBoxes(read, total, limit = 6000) {
    const out = [];
    let o = 0;
    while (o + 8 <= total && out.length < limit) {
      const h = await read(o, Math.min(16, total - o));
      if (h.length < 8) break;
      let size = u32(h, 0);
      let hdr = 8;
      if (size === 1 && h.length >= 16) {
        size = u64(h, 8);
        hdr = 16;
      } else if (size === 0) size = total - o;
      if (size < hdr) break;
      out.push({ type: cc(h, 4), start: o, size, hdr });
      o += size;
    }
    return out.length >= limit ? null : out;
  }

  async function remuxBuild(read0, total, debug = false) {
    // 先頭の 256 KB を 1 回で読んでおく（ftyp・moov・最初の moof の見出しが、ほとんど入る）。通信の往復を減らす（スマホは 1 往復が遅い）
    const pre = await read0(0, Math.min(total, 256 * 1024));
    const read = async (o, n) => (o + n <= pre.length ? pre.slice(o, o + n) : read0(o, n));
    const tops = await topBoxes(read, total);
    if (!tops) return null;
    const moovB = tops.find((b) => b.type === "moov");
    const ftypB = tops.find((b) => b.type === "ftyp");
    if (!moovB || !ftypB || moovB.size > 16 << 20) return null;
    const moov = await read(moovB.start, moovB.size);
    const mv = { start: 0, data: moovB.hdr, end: moov.length };
    const mvex = child(moov, mv, "mvex");
    if (!mvex) return null; // 細かく分けて書かれていない（そのまま流す）
    const mdats = tops.filter((b) => b.type === "mdat");
    const moofs = tops.filter((b) => b.type === "moof");
    if (!moofs.length || !mdats.length) return null;
    const ftyp = await read(ftypB.start, ftypB.size);

    // 既定値（trex）
    const trex = {};
    for (const k of kids(moov, mvex.data, mvex.end)) {
      if (k.type !== "trex") continue;
      trex[u32(moov, k.data + 4)] = { dur: u32(moov, k.data + 12), size: u32(moov, k.data + 16), flags: u32(moov, k.data + 20) };
    }
    // トラック（moov の中の trak）
    const tracks = [];
    for (const t of kids(moov, mv.data, mv.end)) {
      if (t.type !== "trak") continue;
      const tkhd = child(moov, t, "tkhd");
      const mdia = child(moov, t, "mdia");
      const mdhd = mdia && child(moov, mdia, "mdhd");
      const hdlr = mdia && child(moov, mdia, "hdlr");
      const minf = mdia && child(moov, mdia, "minf");
      const stbl = minf && child(moov, minf, "stbl");
      const stsd = stbl && child(moov, stbl, "stsd");
      if (!tkhd || !mdhd || !hdlr || !minf || !stsd) return null;
      const id = u32(moov, tkhd.data + (moov[tkhd.data] === 1 ? 20 : 12));
      tracks.push({
        id,
        tkhd: moov.slice(tkhd.start, tkhd.end),
        mdhd: moov.slice(mdhd.start, mdhd.end),
        hdlr: moov.slice(hdlr.start, hdlr.end),
        stsd: moov.slice(stsd.start, stsd.end),
        // minf の中で、stbl 以外（vmhd / smhd / dinf など）はそのまま使う
        minfKeep: [...kids(moov, minf.data, minf.end)].filter((k) => k.type !== "stbl").map((k) => moov.slice(k.start, k.end)),
        vide: cc(moov, hdlr.data + 8) === "vide",
        samples: [], // { o, n, dur, cts, sync }
      });
    }
    if (!tracks.length) return null;
    const byId = new Map(tracks.map((t) => [t.id, t]));

    // 各 moof の中のコマの表（trun）を読む。moof の中身は、6 つずつ並べて読む（順に読むと、通信の往復が重なる）
    const moofBytes = [];
    for (let k = 0; k < moofs.length; k += 6) moofBytes.push(...(await Promise.all(moofs.slice(k, k + 6).map((mf) => read(mf.start, mf.size)))));
    for (let mi = 0; mi < moofs.length; mi++) {
      const mf = moofs[mi];
      const u = moofBytes[mi];
      for (const traf of kids(u, mf.hdr, u.length)) {
        if (traf.type !== "traf") continue;
        const tfhd = child(u, traf, "tfhd");
        if (!tfhd) return null;
        const tflags = (u[tfhd.data + 1] << 16) | (u[tfhd.data + 2] << 8) | u[tfhd.data + 3];
        const tid = u32(u, tfhd.data + 4);
        const tr = byId.get(tid);
        if (!tr) continue;
        let p = tfhd.data + 8;
        let base = mf.start; // 基準の位置（ふつうは moof の先頭）
        if (tflags & 0x1) {
          base = u64(u, p);
          p += 8;
        }
        if (tflags & 0x2) p += 4;
        const def = { ...(trex[tid] || { dur: 0, size: 0, flags: 0 }) };
        if (tflags & 0x8) {
          def.dur = u32(u, p);
          p += 4;
        }
        if (tflags & 0x10) {
          def.size = u32(u, p);
          p += 4;
        }
        if (tflags & 0x20) {
          def.flags = u32(u, p);
          p += 4;
        }
        // このトラックの最初のコマの時刻（tfdt）。トラックごとに始まりがずれていることがある（映像と音の差）
        if (tr.start == null) {
          const tfdt = child(u, traf, "tfdt");
          tr.start = tfdt ? (u[tfdt.data] === 1 ? u64(u, tfdt.data + 4) : u32(u, tfdt.data + 4)) : 0;
        }
        let cursor = base;
        for (const trun of kids(u, traf.data, traf.end)) {
          if (trun.type !== "trun") continue;
          const rflags = (u[trun.data + 1] << 16) | (u[trun.data + 2] << 8) | u[trun.data + 3];
          const ver = u[trun.data];
          const count = u32(u, trun.data + 4);
          let q = trun.data + 8;
          if (rflags & 0x1) {
            cursor = base + i32(u, q);
            q += 4;
          }
          let first = null;
          if (rflags & 0x4) {
            first = u32(u, q);
            q += 4;
          }
          for (let i = 0; i < count; i++) {
            let dur = def.dur;
            let size = def.size;
            let flags = i === 0 && first != null ? first : def.flags;
            let cts = 0;
            if (rflags & 0x100) {
              dur = u32(u, q);
              q += 4;
            }
            if (rflags & 0x200) {
              size = u32(u, q);
              q += 4;
            }
            if (rflags & 0x400) {
              flags = u32(u, q);
              q += 4;
            }
            if (rflags & 0x800) {
              cts = ver === 1 ? i32(u, q) : u32(u, q);
              q += 4;
            }
            tr.samples.push({ o: cursor, n: size, dur, cts, sync: !(flags & 0x10000) });
            cursor += size;
          }
        }
      }
    }
    if (tracks.every((t) => !t.samples.length)) return null;

    // 仮のファイルの中身の並び（元の mdat の中身を、元の順に）
    const segs = [];
    let payload = 0;
    for (const m of mdats) {
      const n = m.size - m.hdr;
      segs.push({ o: m.start + m.hdr, n, v: payload });
      payload += n;
    }
    const big = payload + 16 > 0xffffffff; // 4GB を超えるなら、位置は 64 ビットで書く
    const mdatHdr = big ? concat([be32(1), Uint8Array.of(0x6d, 0x64, 0x61, 0x74), new Uint8Array(8)]) : concat([be32(8 + payload), Uint8Array.of(0x6d, 0x64, 0x61, 0x74)]);
    if (big) put64(mdatHdr, 8, 16 + payload);
    const toV = (o) => {
      let lo = 0;
      let hi = segs.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const s = segs[mid];
        if (o < s.o) hi = mid - 1;
        else if (o >= s.o + s.n) lo = mid + 1;
        else return s.v + (o - s.o);
      }
      return -1;
    };

    // 動画の長さ（それぞれの時間の単位で）
    const mvhdB = child(moov, mv, "mvhd");
    if (!mvhdB) return null;
    const mvVer = moov[mvhdB.data];
    const movieTs = u32(moov, mvhdB.data + (mvVer === 1 ? 20 : 12));
    const mdhdTs = (t) => u32(t.mdhd, 8 + (t.mdhd[8] === 1 ? 20 : 12));
    const patchDur = (u, off, ver, v) => {
      const c = u.slice();
      if (ver === 1) put64(c, off, v);
      else put32(c, off, v);
      return c;
    };

    // いちばん早く始まるトラックの時刻（秒）。これを 0 に合わせる
    const startMin = Math.min(...tracks.filter((t) => t.samples.length).map((t) => (t.start || 0) / mdhdTs(t)));
    const buildTrak = (t, voffs) => {
      const s = t.samples;
      const mdur = s.reduce((a, x) => a + x.dur, 0);
      const ts = mdhdTs(t);
      const tdur = Math.round((mdur * movieTs) / ts);
      // stts
      const runs = [];
      for (const x of s) {
        const r = runs[runs.length - 1];
        if (r && r[1] === x.dur) r[0]++;
        else runs.push([1, x.dur]);
      }
      const stts = full("stts", 0, 0, be32(runs.length), concat(runs.flatMap(([c, d]) => [be32(c), be32(d)])));
      // ctts（並べ替えのずれがあるときだけ）。最小のずれ（minCts）は ctts から引いて、空の編集（edts）で同じ分だけ始まりを遅らせる
      // （ctts の最小が 0 でない MP4 は、プレーヤーによって始まりの扱いが違い、音とずれることがある。この形なら、どれも同じ）
      const minCts = s.reduce((a, x) => Math.min(a, x.cts), Infinity);
      const shift = minCts > 0 ? minCts : 0;
      let ctts = null;
      if (s.some((x) => x.cts - shift !== 0)) {
        const cr = [];
        for (const x of s) {
          const r = cr[cr.length - 1];
          if (r && r[1] === x.cts - shift) r[0]++;
          else cr.push([1, x.cts - shift]);
        }
        ctts = full("ctts", minCts < 0 ? 1 : 0, 0, be32(cr.length), concat(cr.flatMap(([c, d]) => [be32(c), be32(d >>> 0)])));
      }
      // stss（映像で、全部が区切りでないとき）
      let stss = null;
      if (t.vide && s.some((x) => !x.sync)) {
        const keys = [];
        s.forEach((x, i) => x.sync && keys.push(i + 1));
        stss = full("stss", 0, 0, be32(keys.length), concat(keys.map(be32)));
      }
      // stsz
      const sz = new Uint8Array(s.length * 4);
      s.forEach((x, i) => put32(sz, i * 4, x.n));
      const stsz = full("stsz", 0, 0, be32(0), be32(s.length), sz);
      // チャンク（元のファイルで続いているコマを 1 つのかたまりに）
      const chunks = []; // { first: 先頭のコマの番号, count, o: 元の位置 }
      s.forEach((x, i) => {
        const c = chunks[chunks.length - 1];
        if (c && c.o + c.len === x.o) {
          c.count++;
          c.len += x.n;
        } else chunks.push({ first: i, count: 1, o: x.o, len: x.n });
      });
      const sr = []; // [チャンク番号（1 から）, コマ数]
      chunks.forEach((c, i) => {
        const r = sr[sr.length - 1];
        if (!r || r[1] !== c.count) sr.push([i + 1, c.count]);
      });
      const stsc = full("stsc", 0, 0, be32(sr.length), concat(sr.map(([a, b]) => concat([be32(a), be32(b), be32(1)]))));
      let co;
      if (big) {
        const b = new Uint8Array(chunks.length * 8);
        chunks.forEach((c, i) => put64(b, i * 8, voffs ? voffs(c.o) : 0));
        co = full("co64", 0, 0, be32(chunks.length), b);
      } else {
        const b = new Uint8Array(chunks.length * 4);
        chunks.forEach((c, i) => put32(b, i * 4, voffs ? voffs(c.o) : 0));
        co = full("stco", 0, 0, be32(chunks.length), b);
      }
      const stbl = box("stbl", t.stsd, stts, ...(ctts ? [ctts] : []), ...(stss ? [stss] : []), stsc, stsz, co);
      // tkhd・mdhd の長さを入れる
      const tkVer = t.tkhd[8];
      const tkhd = patchDur(t.tkhd, tkVer === 1 ? 36 : 28, tkVer, tdur);
      const mdVer = t.mdhd[8];
      const mdhd = patchDur(t.mdhd, mdVer === 1 ? 32 : 24, mdVer, mdur);
      // トラックごとの始まりのずれ（tfdt）を、空の編集（edts）で再現する。映像と音がずれないように、元と同じ時刻に始める。
      // （並べ替えのずれ ctts の分は、元のファイルと同じく、そのまま残す）
      const delaySec = t.start / ts - startMin + shift / ts;
      const delay = Math.round(delaySec * movieTs);
      const entries = [];
      if (delay > 0) entries.push([delay, 0xffffffff], [tdur, 0]);
      const edts = entries.length ? box("edts", full("elst", 0, 0, be32(entries.length), concat(entries.flatMap(([d, m]) => [be32(d), be32(m), be32(0x00010000)])))) : null;
      return { bytes: box("trak", tkhd, ...(edts ? [edts] : []), box("mdia", mdhd, t.hdlr, box("minf", ...t.minfKeep, stbl))), tdur };
    };
    const buildMoov = (voffs) => {
      const traks = tracks.filter((t) => t.samples.length).map((t) => buildTrak(t, voffs));
      const movieDur = traks.reduce((a, x) => Math.max(a, x.tdur), 0);
      const mvhd = patchDur(moov.slice(mvhdB.start, mvhdB.end), mvVer === 1 ? 32 : 24, mvVer, movieDur);
      return box("moov", mvhd, ...traks.map((x) => x.bytes));
    };
    // 先に 0 で作って大きさを決め、位置（仮のファイルでの）を入れて作り直す
    const probe = buildMoov(null);
    const headLen = ftyp.length + probe.length + mdatHdr.length;
    const voffs = (o) => {
      const v = toV(o);
      return v < 0 ? 0 : headLen + v;
    };
    const moovNew = buildMoov(voffs);
    const head = concat([ftyp, moovNew, mdatHdr]);
    if (head.length !== headLen) return null;
    return { size: headLen + payload, head, segs: segs.map((s) => ({ ...s, v: headLen + s.v })), ...(debug ? { tracks } : {}) };
  }

  // 仮のファイルの [start, end]（両端を含む）を、元のファイルの範囲に直す
  function remuxPieces(layout, start, end) {
    const out = [];
    const hl = layout.head.length;
    if (start < hl) out.push({ head: layout.head.subarray(start, Math.min(end + 1, hl)) });
    for (const s of layout.segs) {
      if (s.v + s.n <= start || s.v > end) continue;
      const a = Math.max(start, s.v);
      const b = Math.min(end, s.v + s.n - 1);
      out.push({ o: s.o + (a - s.v), n: b - a + 1 });
    }
    return out;
  }

  return { remuxBuild, remuxPieces };
})();
if (typeof module !== "undefined") module.exports = VdhRemux;
