// 縦にスワイプして動画を 1 本ずつ見るプレイヤー（ショート動画のような見た目）。
// 保存した動画の全画面・shorts.html・スマホのページ（phone/）で同じものを使う。
//
// createShortsView(root, items, getSrc, opts)
//   items  … [{ title, sub }]
//   getSrc … (item) => Promise<string>（動画の URL。blob: でもよい）。
//              失敗するときに err.action = { label, run } を付けると、その場にボタンを出して、押したら run() のあと読み直す
//   opts.release(item, url) … 遠くに離れた動画を片付けるときに呼ぶ（blob: を返したら、ここで revoke する）
//   opts.start … 最初に出す番号
//   opts.empty … 1 本も無いときの文
//   opts.explain(item) … 再生できなかったときの理由（Promise<string>）
//
// 操作:
//   スマホ … 上下スワイプで前後へ・タップで止める/動かす・左右をダブルタップで 10 秒戻る/進む・下のバーをつまんで好きな位置へ
//   PC     … ホイール 1 回で 1 本・クリックで止める/動かす・Space/K 止める・←→ 5 秒・↑↓ 前後・M 音・F 全画面・右の矢印ボタン

const SV_PREFS_KEY = "sv-prefs";
const SV_SPEEDS = [1, 1.25, 1.5, 2, 0.75];
const SV_ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  unfull: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M5 5.5v13l9-6.5z" fill="currentColor" stroke="none"/><path d="M18 5.5v13"/></svg>',
  loop: '<svg viewBox="0 0 24 24"><path d="M17 3.5l3 3-3 3"/><path d="M4 11.5v-1a4 4 0 0 1 4-4h12M7 20.5l-3-3 3-3"/><path d="M20 12.5v1a4 4 0 0 1-4 4H4"/></svg>',
  // 輪郭くっきり: 丸の右半分だけ塗る（くっきりした境目・コントラスト）。AI の ✦ とは別の形にする
  sharp: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.6"/><path d="M12 4.4a7.6 7.6 0 0 1 0 15.2z" fill="currentColor" stroke="none"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1-5.1-1.9 5.1-1.9z" fill="currentColor" stroke="none"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" fill="currentColor" stroke="none"/></svg>',
};

function svLoadPrefs() {
  try {
    return { muted: true, speed: 1, autoNext: false, hintShown: false, enhance: true, ...JSON.parse(localStorage.getItem(SV_PREFS_KEY) || "{}") };
  } catch {
    return { muted: true, speed: 1, autoNext: false, hintShown: false, enhance: true };
  }
}
function svSavePrefs(p) {
  try {
    localStorage.setItem(SV_PREFS_KEY, JSON.stringify(p));
  } catch {}
}
function svTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
function svEl(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function createShortsView(root, items, getSrc, opts = {}) {
  root.classList.add("sv");
  root.replaceChildren();
  const prefs = svLoadPrefs();
  let current = -1;
  let destroyed = false; // 閉じたあと（読み込み中だったものを流さない・音を鳴らさない）
  const isTouch = matchMedia("(hover: none), (pointer: coarse)").matches;
  root.classList.toggle("sv-touch", isTouch);

  if (!items.length) {
    root.append(Object.assign(svEl("div", "sv-empty"), { textContent: opts.empty || "まだ動画がありません。" }));
    return { scrollTo() {}, destroy() {} };
  }

  // ---- 全体の飾り: 上の「何本目」・右の操作ボタン・はじめの使い方 ----
  const counter = svEl("div", "sv-counter");
  const rail = svEl("div", "sv-rail");
  const btn = (cls, label, onClick) => {
    const b = svEl("button", `sv-btn ${cls}`);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
      poke();
    });
    rail.append(b);
    return b;
  };
  const upBtn = btn("sv-up", "前の動画（↑）", () => scrollTo(current - 1));
  upBtn.innerHTML = SV_ICONS.up;
  const muteBtn = btn("sv-mute-btn", "音（M）", () => setMuted(!prefs.muted));
  const speedBtn = btn("sv-speed", "再生の速さ", () => {
    const i = SV_SPEEDS.indexOf(prefs.speed);
    prefs.speed = SV_SPEEDS[(i + 1) % SV_SPEEDS.length];
    svSavePrefs(prefs);
    for (const sl of slides) sl.v.playbackRate = prefs.speed;
    paintRail();
    flash(`速さ ${prefs.speed}×`);
  });
  const nextBtn = btn("sv-auto", "終わったら次の動画へ", () => {
    prefs.autoNext = !prefs.autoNext;
    svSavePrefs(prefs);
    for (const sl of slides) sl.v.loop = !prefs.autoNext;
    paintRail();
    flash(prefs.autoNext ? "終わったら次の動画へ" : "同じ動画をくり返す");
  });
  // 輪郭くっきり（sv-enhance.js。見るときだけ GPU で拡大をなめらかに・輪郭をくっきり。ファイルはそのまま）。
  // AI で高画質にしたもの（✦）とは別。AI 版を流しているときは、もう高画質なのでかけない（ボタンも押せない）
  const enhancer = typeof svxCreate === "function" ? svxCreate() : { supported: false, attach() {}, detach() {}, dispose() {} };
  const enhanceBtn = btn("sv-enhance-btn", "輪郭くっきり（E）", () => setEnhance(!prefs.enhance));
  enhanceBtn.innerHTML = SV_ICONS.sharp;
  const isAiItem = () => !!(items[current] && items[current].ai);
  // ファイルの URL（file:///）のまま流している動画（大きい動画など）は、ブラウザの決まりで GPU が絵を読めないのでかけない
  const isFileSrc = (i = current) => !!(slides[i] && slides[i].url && slides[i].url.startsWith("file:"));
  const fullBtn = btn("sv-full", "全画面（F）", toggleFull);
  const downBtn = btn("sv-down", "次の動画（↓）", () => scrollTo(current + 1));
  downBtn.innerHTML = SV_ICONS.down;
  const toastEl = svEl("div", "sv-flash");
  toastEl.hidden = true;
  root.append(counter, rail, toastEl);

  function paintRail() {
    muteBtn.innerHTML = prefs.muted ? SV_ICONS.muted : SV_ICONS.sound;
    muteBtn.classList.toggle("on", !prefs.muted);
    muteBtn.title = prefs.muted ? "音を出す（M）" : "音を消す（M）";
    speedBtn.textContent = `${prefs.speed}×`;
    speedBtn.classList.toggle("on", prefs.speed !== 1);
    nextBtn.innerHTML = prefs.autoNext ? SV_ICONS.next : SV_ICONS.loop;
    nextBtn.classList.toggle("on", prefs.autoNext);
    nextBtn.title = prefs.autoNext ? "終わったら次の動画へ（押すと、くり返しに）" : "同じ動画をくり返す（押すと、終わったら次へ）";
    enhanceBtn.hidden = !enhancer.supported;
    enhanceBtn.disabled = isAiItem();
    enhanceBtn.classList.toggle("on", !!prefs.enhance && !isAiItem() && !isFileSrc());
    enhanceBtn.title = isAiItem()
      ? "AI で高画質にした動画なので、輪郭くっきりはかけません"
      : prefs.enhance && isFileSrc()
        ? "輪郭くっきり: この動画は大きいので、ファイルのまま流していて、かけられません（押すとオフ。E）"
        : prefs.enhance
          ? "輪郭くっきり: オン（見るときだけ。ファイルはそのまま。押すとオフ。E）"
          : "輪郭くっきり: オフ（押すとオン。E）";
    const isFull = document.fullscreenElement === root;
    fullBtn.innerHTML = isFull ? SV_ICONS.unfull : SV_ICONS.full;
    fullBtn.hidden = !root.requestFullscreen;
    upBtn.disabled = current <= 0;
    downBtn.disabled = current >= items.length - 1;
    counter.textContent = `${current + 1} / ${items.length}`;
  }

  let flashTimer = 0;
  function flash(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastEl.classList.remove("show");
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (toastEl.hidden = true), 1300);
  }

  function setMuted(m) {
    // 止めていた動画は止めたまま（音を切り替えただけで動き出さないように）
    const wasPlaying = current >= 0 && !slides[current].v.paused;
    prefs.muted = m;
    svSavePrefs(prefs);
    for (const sl of slides) sl.v.muted = m;
    paintRail();
    if (wasPlaying) play(current);
    flash(m ? "音なし" : "音あり");
  }

  function setEnhance(on) {
    prefs.enhance = on;
    svSavePrefs(prefs);
    // オフのときに file:/// のまま読んだ近くの動画は、読み直す（読み込んで流せば、かけられる。大きい動画はまた file:/// のまま）
    if (on && !isAiItem()) {
      for (let j = current - 1; j <= current + 1; j++) {
        // 大きい動画（300MB 超。shorts.js・library-viewer.js の読み込みと同じ目安）は、読み直しても file:/// のままでかけられない。
        // 止めて読み直すと黒くなって待たされるだけなので、そのままにする
        const d = items[j] && (items[j].d || (items[j].it && items[j].it.d));
        if (!isFileSrc(j) || (d && (d.fileSize || d.totalBytes || 0) > 300 * 1024 * 1024)) continue;
        const sl = slides[j];
        if (j === current) sl.resume = { t: sl.v.currentTime, play: !sl.v.paused };
        unload(j);
        load(j);
      }
    }
    applyEnhance();
    paintRail();
    flash(isAiItem() ? "AI 高画質の動画には、輪郭くっきりはかけません" : on ? "輪郭くっきり: オン（見るときだけ）" : "輪郭くっきり: オフ（元のまま）");
  }
  // 今の 1 本にだけかける（前後の動画は、見るときに）。AI 版にはかけない
  function applyEnhance() {
    const sl = slides[current];
    // まだ読み込み中のものは、読み終わってから（file:/// で流すと分かったら、かけない）
    if (!prefs.enhance || !sl || isAiItem() || !sl.url || isFileSrc()) return enhancer.detach();
    enhancer.attach(sl.v, sl.s, () => flash("この動画は輪郭くっきりにできません（元のまま映します）"));
  }

  function toggleFull() {
    if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
    else root.requestFullscreen?.().catch(() => {});
  }
  const onFull = () => paintRail();
  document.addEventListener("fullscreenchange", onFull);

  // PC: マウスを止めて少したつと、操作ボタンを隠す（動画を見やすく）
  let idleTimer = 0;
  function poke() {
    root.classList.add("sv-ui");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const sl = slides[current];
      if (sl && !sl.v.paused && !dragging) root.classList.remove("sv-ui");
    }, 2600);
  }
  root.addEventListener("mousemove", poke); // 閉じるとき外す（root は次に開くときも使うので）
  poke();

  // ---- 1 本ずつ ----
  let dragging = null;
  const slides = items.map((item, i) => {
    const s = svEl("section", "sv-slide");
    s.dataset.i = String(i);
    const v = document.createElement("video");
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.loop = !prefs.autoNext;
    v.muted = prefs.muted;
    v.preload = "auto";
    const spin = svEl("div", "sv-spin");
    const state = svEl("div", "sv-state");
    state.hidden = true;
    const big = svEl("div", "sv-big", SV_ICONS.play);
    big.hidden = true;
    const seekL = svEl("div", "sv-seek left", "« 10 秒");
    const seekR = svEl("div", "sv-seek right", "10 秒 »");
    const cap = svEl("div", "sv-cap");
    // AI で高画質にした版を流すときは、はっきり札を出す
    if (item.ai) cap.append(Object.assign(svEl("div", "sv-ai-chip"), { textContent: typeof item.ai === "string" ? item.ai : "✦ AI 高画質で再生中" }));
    cap.append(Object.assign(svEl("div", "sv-title"), { textContent: item.title || "" }), Object.assign(svEl("div", "sv-sub"), { textContent: item.sub || "" }));
    // 下の再生バー（つまんで動かせる。触る所は見た目より太い）
    const bar = svEl("div", "sv-bar");
    const track = svEl("div", "sv-track");
    const buf = svEl("div", "sv-buf");
    const fill = svEl("div", "sv-fill");
    const knob = svEl("div", "sv-knob");
    const tip = svEl("div", "sv-tip");
    track.append(buf, fill, knob);
    const times = svEl("div", "sv-times");
    bar.append(tip, track, times);
    s.append(v, spin, big, seekL, seekR, state, cap, bar);

    const paintBar = (t = v.currentTime) => {
      const d = v.duration || 0;
      const r = d ? Math.min(1, t / d) : 0;
      fill.style.width = `${r * 100}%`;
      knob.style.left = `${r * 100}%`;
      times.textContent = d ? `${svTime(t)} / ${svTime(d)}` : "";
      if (v.buffered.length && d) buf.style.width = `${(v.buffered.end(v.buffered.length - 1) / d) * 100}%`;
    };
    v.addEventListener("timeupdate", () => !dragging && paintBar());
    v.addEventListener("progress", () => paintBar());
    v.addEventListener("loadedmetadata", () => {
      v.playbackRate = prefs.speed;
      paintBar();
    });
    v.addEventListener("waiting", () => (spin.hidden = false));
    v.addEventListener("playing", () => {
      spin.hidden = true;
      big.hidden = true;
      s.classList.remove("paused");
      poke();
    });
    v.addEventListener("canplay", () => (spin.hidden = true));
    v.addEventListener("pause", () => {
      if (i !== current) return;
      big.innerHTML = SV_ICONS.play;
      big.hidden = false;
      s.classList.add("paused");
      root.classList.add("sv-ui");
    });
    v.addEventListener("ended", () => prefs.autoNext && i === current && scrollTo(current + 1));
    // 中身が読めても再生できない（形式が合わない）ときは、黒いままにせず理由を出す
    v.addEventListener("error", async () => {
      if (!v.getAttribute("src")) return;
      spin.hidden = true;
      state.hidden = false;
      state.replaceChildren(Object.assign(svEl("div"), { textContent: "この動画は再生できませんでした" }));
      // explain は文字を返しても Promise を返してもよい（前は文字を返すと .catch で止まり、理由が出なかった）
      const why = opts.explain ? await Promise.resolve().then(() => opts.explain(item)).catch(() => "") : "";
      if (why) state.append(Object.assign(svEl("div", "sv-why"), { textContent: why }));
    });

    // バーをつまむ（スクロールにならないよう、ここでは縦の動きも取る）
    const ratioAt = (x) => {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (x - r.left) / r.width));
    };
    bar.addEventListener("pointerdown", (e) => {
      if (!v.duration) return;
      e.stopPropagation();
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      dragging = { i, wasPlaying: !v.paused };
      s.classList.add("scrubbing");
      const t = ratioAt(e.clientX) * v.duration;
      paintBar(t);
      tip.textContent = svTime(t);
      tip.style.left = `${ratioAt(e.clientX) * 100}%`;
      v.pause();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!dragging || dragging.i !== i) {
        // PC: 乗せただけでも、その位置の時間を出す
        if (!isTouch && v.duration) {
          tip.textContent = svTime(ratioAt(e.clientX) * v.duration);
          tip.style.left = `${ratioAt(e.clientX) * 100}%`;
        }
        return;
      }
      const t = ratioAt(e.clientX) * v.duration;
      paintBar(t);
      tip.textContent = svTime(t);
      tip.style.left = `${ratioAt(e.clientX) * 100}%`;
    });
    const endDrag = (e) => {
      if (!dragging || dragging.i !== i) return;
      e.stopPropagation();
      v.currentTime = ratioAt(e.clientX) * v.duration;
      if (dragging.wasPlaying) v.play().catch(() => {});
      dragging = null;
      s.classList.remove("scrubbing");
      poke();
    };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);
    bar.addEventListener("click", (e) => e.stopPropagation());

    // タップ / クリック: 1 回で止める・動かす、左右を 2 回で 10 秒。
    // 2 回目と見る間と、1 回目を「止める」にするまでの待ちは同じ長さ（ずれると、止まったうえに 10 秒動く）
    const TAP_WAIT = 280;
    let tapTimer = 0;
    let tapDone = false; // 1 回目の「止める・動かす」をもうした
    let lastTap = 0;
    s.addEventListener("click", (e) => {
      if (e.target.closest(".sv-bar, .sv-state button")) return;
      const now = Date.now();
      const r = s.getBoundingClientRect();
      const side = e.clientX < r.left + r.width / 2 ? -1 : 1;
      if (now - lastTap < TAP_WAIT) {
        clearTimeout(tapTimer);
        // 時計のずれで 1 回目をもうしていたら、元に戻す
        if (tapDone) togglePlay(i);
        lastTap = 0;
        seekBy(i, side * 10);
        return;
      }
      lastTap = now;
      tapDone = false;
      tapTimer = setTimeout(() => {
        tapDone = true;
        togglePlay(i);
      }, TAP_WAIT);
    });
    return { s, v, spin, state, big, seekL, seekR, paintBar, item, url: null, loading: null };
  });
  root.append(...slides.map((x) => x.s));

  // 初めて開いたときだけ、使い方を少し出す
  if (!prefs.hintShown) {
    const hint = svEl("div", "sv-hint");
    hint.innerHTML = isTouch
      ? "<b>上下にスワイプ</b>で次の動画<br><b>タップ</b>で一時停止<br><b>左右をダブルタップ</b>で 10 秒戻る・進む"
      : "<b>ホイール・↑↓</b>で次の動画<br><b>クリック・Space</b>で一時停止<br><b>←→</b>で 5 秒・<b>M</b> 音・<b>F</b> 全画面・<b>E</b> 輪郭くっきり";
    hint.addEventListener("click", () => hint.remove());
    root.append(hint);
    setTimeout(() => hint.classList.add("out"), 4200);
    setTimeout(() => hint.remove(), 4800);
    prefs.hintShown = true;
    svSavePrefs(prefs);
  }

  function togglePlay(i) {
    const sl = slides[i];
    if (!sl || !sl.url) return;
    if (sl.v.paused) {
      sl.v.play().catch(() => {});
      sl.big.innerHTML = SV_ICONS.play;
    } else sl.v.pause();
  }

  function seekBy(i, sec) {
    const sl = slides[i];
    if (!sl || !sl.v.duration) return;
    sl.v.currentTime = Math.max(0, Math.min(sl.v.duration - 0.1, sl.v.currentTime + sec));
    const el = sec < 0 ? sl.seekL : sl.seekR;
    el.textContent = sec < 0 ? `« ${-sec} 秒` : `${sec} 秒 »`;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    sl.paintBar();
  }

  function load(i) {
    const sl = slides[i];
    if (!sl || sl.url || sl.loading) return;
    sl.spin.hidden = false;
    sl.state.hidden = true;
    sl.loading = Promise.resolve()
      .then(() => getSrc(sl.item))
      .then((url) => {
        sl.loading = null;
        // 閉じたあと・遠くへ移ったあとに読み終わったものは流さない（見えない所で音が鳴らないように）
        if (destroyed || Math.abs(i - current) > 2) {
          if (opts.release) opts.release(sl.item, url);
          return;
        }
        sl.url = url;
        // 隣の動画は、先を読み込まない（metadata だけ）。3 本が同時に読み込まれると、回線の細いスマホでは見ている動画が止まる。
        // 見るとき（setCurrent）に auto に戻す
        sl.v.preload = i === current ? "auto" : "metadata";
        sl.v.src = url;
        sl.v.muted = prefs.muted;
        sl.v.playbackRate = prefs.speed;
        // 読み直したもの（輪郭くっきりをオンにしたとき）は、見ていた所から・止めていたなら止めたまま
        const resume = sl.resume;
        sl.resume = null;
        if (resume && resume.t) sl.v.addEventListener("loadedmetadata", () => (sl.v.currentTime = resume.t), { once: true });
        if (i === current) {
          if (!resume || resume.play) play(i);
          applyEnhance();
          paintRail();
        }
      })
      .catch((err) => {
        sl.loading = null;
        sl.spin.hidden = true;
        sl.state.hidden = false;
        sl.state.replaceChildren(Object.assign(svEl("div"), { textContent: (err && err.message) || "読み込めませんでした" }));
        if (err && err.action) {
          const b = Object.assign(svEl("button", "sv-action"), { type: "button", textContent: err.action.label });
          b.addEventListener("click", async (e) => {
            e.stopPropagation();
            try {
              await err.action.run();
            } catch {}
            load(i);
          });
          sl.state.append(b);
        }
      });
  }

  function unload(i) {
    const sl = slides[i];
    if (!sl.url) return;
    sl.v.pause();
    sl.v.removeAttribute("src");
    sl.v.load();
    if (opts.release) opts.release(sl.item, sl.url);
    sl.url = null;
  }

  function play(i) {
    const sl = slides[i];
    if (destroyed || !sl.url) return;
    sl.v.muted = prefs.muted;
    sl.v.play().catch((err) => {
      // 音ありで勝手に動かせないとき（NotAllowedError）だけ、音なしで動かす（1 回触れば、次から音が出せる）。
      // 次の動画へ移って止めたとき（AbortError）は、何もしない（音を消したり、前の動画を裏で流し直したりしない）
      if (destroyed || i !== current || !err || err.name !== "NotAllowedError") return;
      if (!sl.v.muted) {
        sl.v.muted = true;
        sl.v.play().catch(() => {});
        flash("音を出すには、右の音のボタンを押してください");
        prefs.muted = true;
        paintRail();
      }
    });
  }

  function setCurrent(i) {
    if (destroyed || i === current || i < 0 || i >= slides.length) return;
    current = i;
    slides.forEach((sl, j) => {
      if (j !== i) {
        sl.v.pause();
        sl.big.hidden = true;
      }
      if (Math.abs(j - i) > 2) unload(j);
    });
    load(i);
    load(i + 1);
    load(i - 1);
    const sl = slides[i];
    sl.v.preload = "auto";
    if (sl.url) {
      sl.v.currentTime = 0;
      play(i);
    }
    applyEnhance();
    paintRail();
    if (opts.onChange) opts.onChange(i);
  }

  let settling = false; // 始めの位置を合わせている間
  const io = new IntersectionObserver(
    (entries) => {
      if (settling) return;
      for (const e of entries) if (e.isIntersecting) setCurrent(Number(e.target.dataset.i));
    },
    { root, threshold: 0.6 }
  );
  slides.forEach((sl) => io.observe(sl.s));
  // 念のため、止まったスクロールの位置からも今の 1 本を決める（見張りが動かない場面があるので）
  let scrollTimer = 0;
  const onScroll = () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => root.clientHeight && setCurrent(Math.round(root.scrollTop / root.clientHeight)), 150);
  };
  root.addEventListener("scroll", onScroll);
  // 大きさが変わったとき（全画面にする・戻す・窓の大きさを変える）は、いま見ている 1 本にとどまる。
  // 変わる前の位置（ピクセル）のままだと、背が高くなった分だけ前の動画の位置になり、前の動画に戻ってしまう
  let lastH = -1; // 始めの大きさ（開いた直後の知らせでは何もしない。↓ で動かしている途中を戻さないように）
  const keepPlace = () => {
    const h = root.clientHeight;
    if (lastH < 0) {
      lastH = h;
      return;
    }
    if (!h || h === lastH) return;
    lastH = h;
    const sl = slides[current];
    if (!sl) return;
    clearTimeout(scrollTimer);
    settling = true;
    root.scrollTop = sl.s.offsetTop;
    clearTimeout(keepPlace.t);
    keepPlace.t = setTimeout(() => (settling = false), 300);
  };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(keepPlace) : null;
  if (ro) ro.observe(root);

  function scrollTo(i, smooth = true) {
    const t = Math.max(0, Math.min(slides.length - 1, i));
    root.scrollTo({ top: slides[t].s.offsetTop, behavior: smooth ? "smooth" : "auto" });
  }

  // PC のホイール: 1 回で 1 本だけ（勢いで何本も飛ばないように）
  let wheelLock = 0;
  const onWheel = (e) => {
    if (e.ctrlKey) return; // 拡大縮小はそのまま
    e.preventDefault();
    if (Date.now() < wheelLock || Math.abs(e.deltaY) < 12) return;
    wheelLock = Date.now() + 650;
    scrollTo(current + (e.deltaY > 0 ? 1 : -1));
  };
  root.addEventListener("wheel", onWheel, { passive: false });

  const onKey = (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === "ArrowDown" || k === "j" || k === "PageDown") scrollTo(current + 1);
    else if (k === "ArrowUp" || k === "PageUp") scrollTo(current - 1);
    else if (k === " " || k === "k") togglePlay(current);
    else if (k === "ArrowRight" || k === "l") seekBy(current, 5);
    else if (k === "ArrowLeft" || k === "h") seekBy(current, -5);
    else if (k === "m") setMuted(!prefs.muted);
    else if (k === "f") toggleFull();
    else if (k === "e" && enhancer.supported) setEnhance(isAiItem() ? prefs.enhance : !prefs.enhance);
    else return;
    e.preventDefault();
    poke();
  };
  document.addEventListener("keydown", onKey);

  paintRail();
  const start = Math.max(0, Math.min(slides.length - 1, opts.start || 0));
  // 押したカードを、すぐ「今の 1 本」にする（位置を合わせるのを待つと、その間「0 / N」と出て、↓ も思った所へ行かない）。
  // 位置を合わせ終わるまでは、見張りの「1 本目が見えている」を聞かない（1 本目に戻されないように）
  setCurrent(start);
  if (start) {
    // その場ですぐ合わせる（次の描き直しまで待つと、その間に押した ↓ などを打ち消してしまう）
    settling = true;
    root.scrollTop = slides[start].s.offsetTop;
    setTimeout(() => (settling = false), 300);
  }

  return {
    scrollTo,
    destroy() {
      destroyed = true;
      // 全部の動画を止めて、中身を外す（読み込み中のものは、読み終わったときに上で捨てる）
      for (const sl of slides) {
        sl.v.pause();
        sl.v.muted = true;
      }
      io.disconnect();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onFull);
      if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
      // root は次に開くときも使うので、ここで付けたものは全部外す（残すと、閉じたプレイヤーと WebGL がずっと残る）
      root.removeEventListener("mousemove", poke);
      root.removeEventListener("scroll", onScroll);
      if (ro) ro.disconnect();
      clearTimeout(keepPlace.t);
      root.removeEventListener("wheel", onWheel, { passive: false });
      clearTimeout(idleTimer);
      clearTimeout(scrollTimer);
      clearTimeout(flashTimer);
      enhancer.dispose();
      slides.forEach((_, j) => unload(j));
      root.replaceChildren();
      root.classList.remove("sv-ui", "sv-touch");
    },
  };
}
