// クラウド（Google ドライブ）に保存する設定。作者が Google Cloud で一度だけ作って入れる（手順は CLAUDE.md の「スマホで見る」）。
// 使う人は何も設定しない（「Google ドライブにつなぐ」を押して自分のアカウントを選ぶだけ）。拡張と、スマホのページ（phone/）の両方で使う
// クライアント ID は秘密ではない（ブラウザに渡る値）。クライアント シークレットは使わないので、ここには入れない

// OAuth クライアント ID（Google Cloud のプロジェクト kirinuki-assistant。種類は「ウェブ アプリケーション」。スコープは drive.file だけ）
// 承認済みのリダイレクト URI に、拡張ごとの https://<拡張の ID>.chromiumapp.org/ を足しておく（ストアに出したら、その ID の分も）
const GOOGLE_CLIENT_ID = "763980658077-31urrgah0hfkpg85qgn7853b8te53f9n.apps.googleusercontent.com";
// スマホで開くページの場所（dist/phone/ を置いた URL。例 https://kirinuki-phone.pages.dev/）
const PHONE_VIEWER_URL = "https://ikasumi1503.github.io/kirinuki-phone/"; // GitHub Pages（npm run deploy-phone で置き直す）
