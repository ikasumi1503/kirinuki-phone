// スマホのページ: Google ドライブの「切り抜きアシスタント」フォルダの動画を、縦スワイプで見る。
// ログインは Google の仕組み（Google Identity Services）。見られるのはこのアプリが作ったファイルだけ（drive.file）

const PH_FOLDER = "切り抜きアシスタント";
const PH_API = "https://www.googleapis.com/drive/v3";
let phToken = "";
let phTokenClient = null;
let phView = null;
let phEmail = ""; // ログインしているアカウント（上に出す。別のアカウントで入ったと気づけるように）
const PH_HINT_KEY = "kiriPhoneAccount"; // 前に入ったアカウント（次は、それを先に選ぶ）
const phHint = () => {
  try {
    return localStorage.getItem(PH_HINT_KEY) || "";
  } catch {
    return "";
  }
};

const phMsg = (text) => {
  const m = document.getElementById("msg");
  m.textContent = text || "";
  m.hidden = !text;
};

// 見ている画面の上に、しばらく知らせを出す（#msg は始めの画面の中なので、ログインのあとは見えない）
let phToastTimer = 0;
const phToast = (text) => {
  const t = document.getElementById("toast");
  t.textContent = text || "";
  t.hidden = !text;
  clearTimeout(phToastTimer);
  if (text) phToastTimer = setTimeout(() => (t.hidden = true), 8000);
};
document.getElementById("toast").addEventListener("click", () => phToast("")); // 押せば消える

// Google のログインの部品が読み込まれるのを待つ
function phGoogle() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function wait() {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve(google.accounts.oauth2);
      if (Date.now() - t0 > 15000) return reject(new Error("Google のログインを読み込めませんでした。電波の良いところで開き直してください。"));
      setTimeout(wait, 100);
    })();
  });
}

// ログインして鍵をもらう（ボタンを押したときに呼ぶ。Google の小さな画面が出る）
// pick: アカウントを選び直す（違うアカウントで入ったとき）
const PH_SCOPE = "https://www.googleapis.com/auth/drive.file";
let phWaiting = false; // Google のログインの画面から戻ってくるのを待っている

// アプリの中のブラウザ（LINE・Instagram・Gmail などで開いたページ）は、Google のログインの画面から戻れないことがある
const phInApp = () => /\bLine\/|Instagram|FBAN|FBAV|FB_IAB|GSA\/|Twitter|MicroMessenger|; wv\)/i.test(navigator.userAgent);

let phPending = null; // いま待っているログイン（{ resolve, reject }）
let phNeedConsent = false; // ドライブのチェックが外れていた: 次は同意の画面を必ず出す
const PH_TOKEN_KEY = "kiriPhoneToken"; // このタブで受け取った鍵（ログインの途中でページが読み込み直されても、続きから見られるように）

// ログインの部品は、ページを開いたときに用意しておく（押したときに待つと、iPhone ではログインの画面が別のタブで開き、返事が戻らないことがある）
function phInitClient() {
  if (phTokenClient || !(window.google && google.accounts && google.accounts.oauth2) || !GOOGLE_CLIENT_ID) return !!phTokenClient;
  const oauth2 = google.accounts.oauth2;
  const done = (fn, v) => {
    phWaiting = false;
    try {
      sessionStorage.removeItem("kiriPhoneLoggingIn");
    } catch {}
    const p = phPending;
    phPending = null;
    if (p) p[fn](v);
  };
  const fail = (text) => done("reject", new Error(text));
  phTokenClient = oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: PH_SCOPE,
    callback: (r) => {
      if (r.error) {
        // access_denied: Google の画面で「キャンセル」・アカウントの管理者が止めている など
        return fail(r.error === "access_denied" ? "Google の画面で許可されませんでした（アカウントの管理者が、このアプリを止めていることもあります）。もう一度押して、「許可」または「続行」を選んでください。" : `Google にログインできませんでした（${r.error}${r.error_description ? `: ${r.error_description}` : ""}）`);
      }
      if (!r.access_token) return fail("Google にログインできませんでした（鍵が届きませんでした）。もう一度押してください。");
      // Google の画面で、ドライブのチェックを外すと、鍵は来てもドライブを見られない
      if (oauth2.hasGrantedAllScopes && !oauth2.hasGrantedAllScopes(r, PH_SCOPE)) {
        phNeedConsent = true;
        return fail("Google ドライブを見る許可がありませんでした。もう一度押して、Google の画面で「Google ドライブのファイル」にチェックを入れたまま「続行」を押してください。");
      }
      phNeedConsent = false;
      phToken = r.access_token;
      try {
        // 1 時間は、ページを閉じて開き直しても、ログインし直さずに見られるように（localStorage にも置く。鍵は 1 時間で切れる）
        const saved = JSON.stringify({ token: r.access_token, until: Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000 });
        sessionStorage.setItem(PH_TOKEN_KEY, saved);
        try {
          localStorage.setItem(PH_TOKEN_KEY, saved);
        } catch {}
      } catch {}
      done("resolve", phToken);
    },
    error_callback: (err) => {
      const t = (err && err.type) || "";
      if (t === "popup_failed_to_open") return fail(`ログインの画面を開けませんでした。${phInApp() ? "アプリの中のブラウザでは開けないことがあります。右上のメニューから「Safari で開く」「Chrome で開く」を選んで、そちらで開いてください。" : "ブラウザがポップアップを止めているかもしれません。もう一度押してください。"}`);
      if (t === "popup_closed") return fail(`ログインの画面が閉じられました。もう一度押してください。${phInApp() ? "（アプリの中のブラウザでは、うまく戻れないことがあります。Safari か Chrome で開いてください）" : ""}`);
      fail(`ログインがうまくいきませんでした（${t || "わからない理由"}）。もう一度押してください。`);
    },
  });
  return true;
}
// Google の部品が読み込まれたら、すぐ用意する
phGoogle().then(phInitClient, () => {});

// ログインして鍵をもらう（ボタンを押したときに呼ぶ）。押したらすぐ（待たずに）ログインの画面を開く
// pick: アカウントを選び直す（違うアカウントで入ったとき）
function phLogin(pick = false) {
  if (!phInitClient()) return phGoogle().then(() => (phInitClient(), phLogin(pick)));
  // 前の（返事が戻らなかった）ログインは、黙って取りやめる
  if (phPending) phPending.reject(Object.assign(new Error(""), { superseded: true }));
  return new Promise((resolve, reject) => {
    phPending = { resolve, reject };
    phWaiting = true;
    try {
      sessionStorage.setItem("kiriPhoneLoggingIn", String(Date.now()));
    } catch {}
    const hint = pick ? "" : phHint();
    phTokenClient.requestAccessToken({ prompt: phNeedConsent ? "consent" : pick ? "select_account" : "", ...(hint ? { hint } : {}) });
  });
}

// このタブで前に受け取った鍵（まだ使えるもの）
function phSavedToken() {
  for (const st of [() => sessionStorage, () => localStorage]) {
    try {
      const t = JSON.parse(st().getItem(PH_TOKEN_KEY) || "null");
      if (t && t.token && t.until > Date.now()) return t.token;
    } catch {}
  }
  return "";
}
const phClearToken = () => {
  for (const st of [() => sessionStorage, () => localStorage])
    try {
      st().removeItem(PH_TOKEN_KEY);
    } catch {}
};

async function phFetch(url) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${phToken}` } });
  if (r.status === 401) {
    phClearToken();
    const e = new Error("ログインの期限が切れました。");
    e.action = { label: "もう一度ログイン", run: phLogin };
    throw e;
  }
  if (r.status === 403) throw new Error("Google ドライブを見る許可がありません。もう一度ログインして、Google の画面で「Google ドライブのファイル」にチェックを入れてください。");
  if (!r.ok) throw new Error(`Google ドライブの応答が HTTP ${r.status}`);
  return r;
}

// 「切り抜きアシスタント」フォルダの中: パソコンのアプリと同じフォルダ分け（中のフォルダ）と、動画（新しい順）
let phAll = { folders: [], files: [] };
let phFolder = "all";

// 1 回に返ってくるのは 500 件までなので、続き（nextPageToken）があれば全部もらう
async function phChildren(parent, q) {
  const query = `'${parent}' in parents and trashed=false and (${q})`;
  const all = [];
  let page = "";
  do {
    const res = await (await phFetch(`${PH_API}/files?q=${encodeURIComponent(query)}&orderBy=createdTime desc&pageSize=500&fields=nextPageToken,files(id,name,size,createdTime,mimeType)${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`)).json();
    all.push(...(res.files || []));
    page = res.nextPageToken || "";
  } while (page);
  return all;
}

async function phList() {
  const fq = `name='${PH_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const roots = (await (await phFetch(`${PH_API}/files?q=${encodeURIComponent(fq)}&fields=files(id)&spaces=drive`)).json()).files || [];
  const folders = [];
  const files = [];
  // 通信は並べて出す（順に待つと、フォルダの数だけ遅くなる）
  const tops = await Promise.all(roots.map((r) => phChildren(r.id, "mimeType contains 'video/' or mimeType='application/vnd.google-apps.folder'")));
  for (const kids of tops)
    for (const k of kids) {
      if (k.mimeType === "application/vnd.google-apps.folder") folders.push({ id: k.id, name: k.name });
      else files.push({ ...k, folder: "none" });
    }
  const inner = await Promise.all(folders.map((fo) => phChildren(fo.id, "mimeType contains 'video/'").then((kids) => kids.map((k) => ({ ...k, folder: fo.id })))));
  for (const kids of inner) files.push(...kids);
  folders.sort((x, y) => x.name.localeCompare(y.name, "ja"));
  return { folders, files: files.sort((x, y) => (x.createdTime < y.createdTime ? 1 : -1)) };
}

// 上のフォルダの札（押すとそのフォルダだけで見る）
function phChips() {
  const box = document.getElementById("folders");
  const count = (id) => (id === "all" ? phAll.files.length : phAll.files.filter((x) => x.folder === id).length);
  const list = [["all", "すべて"], ...(phAll.files.some((x) => x.folder === "none") ? [["none", "フォルダなし"]] : []), ...phAll.folders.map((x) => [x.id, x.name])];
  box.replaceChildren(
    ...list.map(([id, name]) => {
      const b = Object.assign(document.createElement("button"), { type: "button", className: `ph-chip${phFolder === id ? " on" : ""}`, textContent: `${name} ${count(id)}` });
      b.addEventListener("click", () => {
        phFolder = id;
        phChips();
        phLibRender();
      });
      return b;
    })
  );
  box.hidden = list.length <= 1;
}

// 縦スワイプで見る画面。files = 見る動画（一覧で見えているもの）、start = 最初に出す番号
function phViewer(files, start = 0) {
  if (phView) phView.destroy();
  phView = null;
  const folderName = (id) => (id === "none" ? "" : (phAll.folders.find((x) => x.id === id) || {}).name || "");
  phView = createShortsView(
    document.getElementById("view"),
    files.map((x) => ({ f: x, title: x.name.replace(/\.[^.]+$/, ""), sub: [folderName(x.folder), new Date(x.createdTime).toLocaleDateString("ja-JP")].filter(Boolean).join("・") })),
    // 動画の中身をもらってから流す（ドライブの動画は、鍵を付けないと読めないので）
    // 前に上げた動画は、長さの欄が「わからない」（13 時間などに見える）ことがあるので、直してから流す（ts-mp4.js）
    async (item) => {
      // 流す係（sw.js）が動いていれば、全部読み込まずに見ている所だけ少しずつ流す（大きな動画でもスマホで流せる）
      if (await phStreamReady()) return `./stream/${encodeURIComponent(item.f.id)}?t=${encodeURIComponent(phToken)}&s=${Number(item.f.size) || 0}${PH_TEST_API ? `&api=${encodeURIComponent(PH_TEST_API)}` : ""}`;
      // 流す係が動き出せなかった。大きな動画（80 MB 超）を丸ごと読み込むのは、スマホでは重すぎて止まる・読み込めない。
      // 読み込み直せば、流す係が動き出すことが多い
      if (Number(item.f.size) > 80e6) {
        const e = new Error("動画を流す準備ができていません。もう一度読み込み直してください。");
        e.action = { label: "読み込み直す", run: () => location.reload() };
        throw e;
      }
      // 小さな動画は、前のとおり丸ごと読み込んでから流す（長さの欄も直す）
      const blob = await (await phFetch(`${PH_API}/files/${item.f.id}?alt=media`)).blob();
      return URL.createObjectURL(typeof fmp4FixDuration === "function" ? await fmp4FixDuration(blob).catch(() => blob) : blob);
    },
    {
      start,
      release: (_, url) => String(url).startsWith("blob:") && URL.revokeObjectURL(url),
      // 再生できなかったときの理由（どこで止まったかを知るため）
      explain: (item) => phWhy(item),
      empty: "動画がありません。",
    }
  );
  return phView;
}

// 1 本も無いとき: 別のアカウントで入っていることが多いので、アカウントを出して、選び直せるようにする
function phEmptyBox(box) {
  const p = (t) => Object.assign(document.createElement("p"), { textContent: t });
  const sw = Object.assign(document.createElement("button"), { type: "button", className: "sv-action", textContent: "別のアカウントで入り直す" });
  sw.addEventListener("click", phSwitch);
  box.append(
    p(`${phEmail || "このアカウント"} のドライブには、「${PH_FOLDER}」フォルダの動画がありません。`),
    p("パソコンでクラウドにつないだのと別の Google アカウントで入っているかもしれません。パソコンと同じアカウントで入り直してください。"),
    sw,
    Object.assign(p("パソコンでまだクラウドにつないでいなければ、「保存した動画」で「クラウドにつなぐ」を押すと、ここに並びます。"), { className: "note" })
  );
}

// いま入っているアカウントを調べて、上に出す
async function phWho() {
  try {
    const me = await (await phFetch(`${PH_API}/about?fields=user(emailAddress)`)).json();
    phEmail = (me.user && me.user.emailAddress) || "";
    if (phEmail) localStorage.setItem(PH_HINT_KEY, phEmail);
  } catch {}
  const b = document.getElementById("account");
  b.textContent = phEmail ? phEmail.replace(/@.*/, "") : "アカウント";
  b.title = phEmail ? `${phEmail} で見ています。押すと別のアカウントに切り替え` : "押すと別のアカウントに切り替え";
}

// 別のアカウントで入り直す。
// 前のログインは、新しく入れるまで残す（やめた・閉じたときは、そのまま前のアカウントで見続けられるように）
async function phSwitch() {
  const oldToken = phToken;
  const oldEmail = phEmail;
  try {
    await phLogin(true); // 押したらすぐ開く（この前で待たない）。入れたら phToken が新しい鍵になる
  } catch (e) {
    if (e.superseded) return; // あとから押したログインに替わった: 黙る
    alert(e.message || String(e));
    return;
  }
  phEmail = "";
  try {
    localStorage.removeItem(PH_HINT_KEY);
  } catch {}
  try {
    await phShow();
  } catch (e) {
    alert(e.message || String(e));
  }
  // 前の鍵は、別のアカウントに替わったと分かったときだけ返す（同じアカウントで返すと、新しい鍵まで使えなくなることがある）
  if (oldToken && oldToken !== phToken && oldEmail && phEmail && oldEmail !== phEmail) {
    try {
      if (window.google && google.accounts.oauth2.revoke) google.accounts.oauth2.revoke(oldToken, () => {});
    } catch {}
  }
}

// 前に読んだ一覧を覚えておく（次に開いたとき、通信を待たずに、すぐ一覧を出すため）
const PH_LIST_KEY = "kiriPhoneList";
function phCachedList() {
  try {
    const c = JSON.parse(localStorage.getItem(PH_LIST_KEY) || "null");
    return c && c.all && Array.isArray(c.all.files) && c.hint === phHint() ? c.all : null;
  } catch {
    return null;
  }
}
const phPerf = {}; // 遅さを調べるための時間（診断に入れる）
async function phShow() {
  const t0 = performance.now();
  phAll = await phList();
  phPerf.listMs = Math.round(performance.now() - t0);
  if (!phEmail) await phWho();
  try {
    localStorage.setItem(PH_LIST_KEY, JSON.stringify({ at: Date.now(), hint: phHint(), all: phAll }));
  } catch {}
  if (phFolder !== "all" && phFolder !== "none" && !phAll.folders.some((x) => x.id === phFolder)) phFolder = "all";
  document.getElementById("start").hidden = true;
  phChips();
  phLibRender();
}

// 進み具合（ログイン中・読み込み中）を、ボタンの下に出す
const phStatus = (text) => {
  const s = document.getElementById("status");
  s.textContent = text || "";
  s.hidden = !text;
};

document.getElementById("login").addEventListener("click", async () => {
  phMsg("");
  if (!GOOGLE_CLIENT_ID) return phMsg("このページはまだ準備中です。");
  const btn = document.getElementById("login");
  btn.disabled = true;
  let superseded = false;
  try {
    const login = phLogin(); // 押したらすぐ開く（この前で待たない）
    phStatus("Google のログインの画面で、アカウントを選んでください…");
    await login;
    phStatus("ドライブの動画を読み込んでいます…");
    await phShow();
  } catch (e) {
    superseded = !!e.superseded;
    if (!superseded) phMsg(e.message || String(e));
  } finally {
    if (!superseded) {
      btn.disabled = false;
      phStatus("");
    }
  }
});

// ログインの画面からこのページに戻ってきたのに、Google から返事が来ないとき（アプリの中のブラウザなどで起きる）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !phWaiting) return;
  setTimeout(() => {
    if (!phWaiting) return;
    phMsg(
      phInApp()
        ? "Google のログインから戻れていないようです。アプリの中のブラウザでは戻れないことがあります。右上のメニューから「Safari で開く」「Chrome で開く」を選んで、そちらで開いてください。"
        : "Google のログインから戻れていないようです。ログインの画面（別のタブ）が残っていれば閉じて、もう一度「Google でログインして見る」を押してください。"
    );
    document.getElementById("login").disabled = false;
  }, 4000);
});

document.getElementById("account").addEventListener("click", phSwitch);

document.getElementById("reload").addEventListener("click", async () => {
  phToast("");
  // 鍵の期限が切れていれば、押したその場でログインの画面を開く（待ったあとに開くと、ブラウザに止められることがある）
  let login = null;
  if (!phSavedToken()) {
    phToken = "";
    login = phLogin();
  }
  try {
    if (login) await login;
    await phShow();
  } catch (e) {
    if (e.superseded) return; // あとから押したログインに替わった: 黙る
    // 期限切れ（401）は、鍵をもう消してあるので、もう一度 ↻ を押せば、その場でログインし直せる
    phToast(e.action ? `${e.message}もう一度 ↻ を押すと、ログインし直します。` : e.message || String(e));
  }
});

// アプリの中のブラウザで開いたときは、先に知らせる（Google のログインから戻れないことがある）
if (phInApp()) phMsg("アプリの中のブラウザで開いています。Google のログインがうまくいかないときは、右上のメニューから「Safari で開く」「Chrome で開く」を選んでください。");

// ---- 流す係（sw.js） ----
// 確かめ用: 手元（localhost）で開いたときだけ、?api= で偽のドライブを使える
const PH_TEST_API = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? new URLSearchParams(location.search).get("api") || "" : "";
const phStreamOk = () => !!(navigator.serviceWorker && navigator.serviceWorker.controller);
// 流す係が動き出すのを、少し待つ（初めて開いたときは、動き出す前に動画を押すと、動画を丸ごと読み込む遅い道になってしまう）
async function phStreamReady() {
  if (phStreamOk()) return true;
  if (!navigator.serviceWorker) return false;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await Promise.race([navigator.serviceWorker.ready, wait(5000)]);
    if (!phStreamOk()) await Promise.race([new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true })), wait(3000)]);
  } catch {}
  return phStreamOk();
}
if (navigator.serviceWorker) navigator.serviceWorker.register("sw.js").catch(() => {});

// 再生できなかったときに出す理由
const PH_MEDIA_ERR = { 1: "読み込みが止められました", 2: "通信が切れました", 3: "動画を読み解けませんでした", 4: "この形式は流せません" };
async function phWhy(item) {
  // 止まった動画（この動画を流していて、まちがいの印があるもの）
  const v = [...document.querySelectorAll("#view video")].find((x) => x.error && String(x.currentSrc || x.src).includes(encodeURIComponent(item.f.id)));
  const e = v && v.error;
  const how = phStreamOk() ? "少しずつ流す" : "丸ごと読み込む";
  const size = item && item.f && item.f.size ? `・${Math.round(item.f.size / 1048576)} MB` : "";
  // ログインの期限（1 時間）が切れていると、ドライブが動画を渡さない
  if (!phSavedToken()) return "理由: ログインの期限が切れました。右上の ↻ を押して、ログインし直してください";
  // 動画の先頭と末尾を少しだけ読んで、どこで止まるかを調べる（スマホで流れない原因を見つけるため）
  let probe = "";
  const src = v && v.getAttribute("src");
  if (src && /^\.\/stream\//.test(src) && item.f.size) {
    const one = async (range) => {
      try {
        const r = await fetch(src, { headers: { Range: range } });
        const b = new Uint8Array(await r.arrayBuffer());
        return `${r.status}・${b.length}B・${String.fromCharCode(...b.slice(4, 8)).replace(/[^ -~]/g, "?")}`;
      } catch (x) {
        return `失敗(${(x && x.message) || x})`;
      }
    };
    const n = Number(item.f.size);
    probe = `／先頭 ${await one("bytes=0-31")}／末尾 ${await one(`bytes=${n - 32}-${n - 1}`)}`;
  }
  return `理由: ${(e && (PH_MEDIA_ERR[e.code] || `コード ${e.code}`)) || "わからない"}${e && e.message ? `（${e.message}）` : ""}（${how}${size}${probe}）`;
}

// このタブで前にログインしていれば（ログインの途中でページが読み込み直されたときなど）、そのまま見る
(async () => {
  const t = phSavedToken();
  if (!t) {
    try {
      // ログインの途中でページが読み込み直された（返事が戻らなかった）
      if (sessionStorage.getItem("kiriPhoneLoggingIn")) {
        sessionStorage.removeItem("kiriPhoneLoggingIn");
        phMsg("Google のログインの途中でページが読み込み直されました。もう一度「Google でログインして見る」を押してください。");
      }
    } catch {}
    return;
  }
  phToken = t;
  // 前に読んだ一覧があれば、先にそれを出す（通信を待たない）。そのあと、新しい一覧に入れ替える
  const cached = phCachedList();
  if (cached) {
    phAll = cached;
    phPerf.cachedShown = Math.round(performance.now());
    phChips();
    phLibRender();
  }
  try {
    if (!cached) phStatus("ドライブの動画を読み込んでいます…");
    await phShow();
  } catch (e) {
    if (cached) phToast(e.message || String(e));
    else phMsg(e.message || String(e));
  } finally {
    phStatus("");
  }
})();

// ---- 再生できないときの診断（ボタンを押すと、調べた結果を自分の Google ドライブへ 1 つのファイルで保存する）----
// 動画の中身・名前・鍵は入れない（端末・ブラウザの種類、エラーの番号、先頭と末尾を少し読んだ結果、箱の並びだけ）。
// 保存先は自分のドライブの「マイドライブ」直下の「切り抜きアシスタント-診断.json」（このアプリが作ったファイルとして）
async function phDiagnose() {
  const v = [...document.querySelectorAll("#view video")].find((x) => x.error) || document.querySelector("#view video");
  const src = (v && v.getAttribute("src")) || "";
  const id = (/\/stream\/([A-Za-z0-9_-]+)/.exec(src) || [])[1] || "";
  const f = (phAll.files || []).find((x) => x.id === id) || {};
  const size = Number(f.size) || 0;
  const d = {
    at: new Date().toISOString(),
    ua: navigator.userAgent,
    platform: navigator.platform,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    sw: { supported: !!navigator.serviceWorker, controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller), visibility: document.visibilityState },
    mse: { MediaSource: typeof MediaSource, Managed: typeof ManagedMediaSource },
    video: v && { error: v.error && { code: v.error.code, message: v.error.message }, networkState: v.networkState, readyState: v.readyState, duration: v.duration, w: v.videoWidth, h: v.videoHeight, src: src.replace(/t=[^&]+/, "t=…") },
    file: { id, size, mime: f.mimeType, createdTime: f.createdTime },
    perf: phPerf,
    thumbErrs: typeof phThumbErrs !== "undefined" ? phThumbErrs : null,
    stalls: phStall,
    playback: (() => {
      const q = v && v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
      const b = v && v.buffered;
      let prefs = null;
      try {
        prefs = JSON.parse(localStorage.getItem("sv-prefs") || "null");
      } catch {}
      return { dropped: q && q.droppedVideoFrames, total: q && q.totalVideoFrames, bufferedEnd: b && b.length ? b.end(b.length - 1) : null, currentTime: v && v.currentTime, enhance: prefs && prefs.enhance, rate: v && v.playbackRate, conn: navigator.connection ? { type: navigator.connection.effectiveType, down: navigator.connection.downlink } : null };
    })(),
    tokenLeftMin: (() => {
      for (const st of [() => sessionStorage, () => localStorage])
        try {
          const t = JSON.parse(st().getItem(PH_TOKEN_KEY) || "null");
          if (t && t.until) return Math.round((t.until - Date.now()) / 60000);
        } catch {}
      return null;
    })(),
    canPlay: Object.fromEntries(["video/mp4", 'video/mp4; codecs="avc1.640029, mp4a.40.2"', 'video/mp4; codecs="avc1.4d001e, mp4a.40.2"', 'video/mp4; codecs="avc1.640029, opus"'].map((t) => [t, document.createElement("video").canPlayType(t)])),
    probes: [],
  };
  const hdr = (r) => ({ status: r.status, range: r.headers.get("content-range"), len: r.headers.get("content-length"), type: r.headers.get("content-type") });
  const one = async (label, url, init, want) => {
    try {
      const r = await fetch(url, init);
      const b = new Uint8Array(await r.arrayBuffer());
      d.probes.push({ label, ...hdr(r), got: b.length, want, head: Array.from(b.slice(0, 16)).map((x) => x.toString(16).padStart(2, "0")).join(""), box: String.fromCharCode(...b.slice(4, 8)).replace(/[^ -~]/g, "?") });
      return b;
    } catch (e) {
      d.probes.push({ label, error: String((e && e.message) || e) });
      return null;
    }
  };
  if (src && size) {
    // 流す係を通した読み（スマホの再生と同じ道）と、ドライブへ直に読んだもの（比べる）
    await one("sw 先頭 0-31", src, { headers: { Range: "bytes=0-31" } }, 32);
    await one("sw 末尾", src, { headers: { Range: `bytes=${size - 32}-${size - 1}` } }, 32);
    await one("sw 2 バイト", src, { headers: { Range: "bytes=0-1" } }, 2);
    await one("直 先頭 0-31", `${PH_API}/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${phToken}`, Range: "bytes=0-31" } }, 32);
    // 箱の並び（大きさと名前だけ。先頭から順に 12 個まで）
    let pos = 0;
    d.boxes = [];
    for (let i = 0; i < 12 && pos < size; i++) {
      const b = await one(`box@${pos}`, src, { headers: { Range: `bytes=${pos}-${Math.min(size - 1, pos + 15)}` } }, 16);
      if (!b || b.length < 8) break;
      const dv = new DataView(b.buffer, b.byteOffset);
      let sz = dv.getUint32(0);
      if (sz === 1 && b.length >= 16) sz = Number(dv.getBigUint64(8));
      if (sz === 0) sz = size - pos;
      d.boxes.push(`${String.fromCharCode(...b.slice(4, 8))}:${sz}@${pos}`);
      if (!sz) break;
      pos += sz;
    }
  }
  // ドライブへ保存（マイドライブ直下。同じ名前があれば作り直す）
  // 流す係の記録（ドライブの返事までの時間・流れの太さ・止まり方）
  d.swStats = await new Promise((resolve) => {
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = (ev) => resolve(ev.data);
      navigator.serviceWorker.controller.postMessage({ type: "stats" }, [ch.port2]);
    } catch {
      resolve(null);
    }
    setTimeout(() => resolve(null), 2500);
  });
  const body = JSON.stringify(d, null, 1);
  const meta = { name: "切り抜きアシスタント-診断.json", mimeType: "application/json" };
  const boundary = "kiri" + Math.random().toString(36).slice(2);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${phToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`,
  });
  if (!r.ok) throw new Error(`ドライブへ保存できませんでした（HTTP ${r.status}）`);
  return d;
}

let phDiagBtn = null;
function phShowDiagButton() {
  if (phDiagBtn || !document.getElementById("view")) return;
  {
    phDiagBtn = Object.assign(document.createElement("button"), { type: "button", className: "sv-action", textContent: "この不具合の情報を保存（開発者に伝える）" });
    Object.assign(phDiagBtn.style, { position: "fixed", left: "12px", right: "12px", bottom: "calc(env(safe-area-inset-bottom, 0px) + 72px)", zIndex: 60 });
    phDiagBtn.addEventListener("click", async () => {
      phDiagBtn.disabled = true;
      phDiagBtn.textContent = "調べています…";
      try {
        await phDiagnose();
        phDiagBtn.textContent = "保存しました。パソコンの Claude に「診断を保存した」と伝えてください";
      } catch (e) {
        phDiagBtn.disabled = false;
        phDiagBtn.textContent = `失敗: ${(e && e.message) || e}（もう一度押す）`;
      }
    });
    document.body.append(phDiagBtn);
  }
}
// 一覧のサムネイルを作るための見えない動画のまちがいでは出さない（見る画面の動画だけ）
document.addEventListener("error", (ev) => ev.target instanceof HTMLVideoElement && ev.target.closest("#view") && phShowDiagButton(), true);
// 止まる（waiting）が続くときも出す。止まった回数・時間・読み込めている先も診断に入れる
const phStall = { count: 0, log: [] };
document.addEventListener(
  "waiting",
  (ev) => {
    const v = ev.target;
    if (!(v instanceof HTMLVideoElement) || !v.closest("#view") || v.currentTime < 0.5) return; // 始めの読み込みは数えない
    const b = v.buffered;
    phStall.count++;
    if (phStall.log.length < 30) phStall.log.push({ at: Math.round(v.currentTime), bufEnd: b.length ? Math.round(b.end(b.length - 1)) : null, rs: v.readyState });
    if (phStall.count >= 3) phShowDiagButton();
  },
  true
);
// 見る画面で、最初の絵が出るまでの時間
document.addEventListener(
  "playing",
  (ev) => {
    if (ev.target instanceof HTMLVideoElement && ev.target.closest("#view") && phPerf.openAt != null && phPerf.firstPlayMs == null) phPerf.firstPlayMs = Math.round(performance.now() - phPerf.openAt);
  },
  true
);
