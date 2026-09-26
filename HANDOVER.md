# HANDOVER — field_visit_map

## 目的

Kazさんから「Googleマップの保存した場所機能では、写真添付・訪問者記録・チーム共有が
できず物足りない」という相談があり(2026-09-26)、専用のWebアプリを新規に作ることになった。
用途は現場・圃場の巡回記録。要件は以下で確定:

- 「誰が行ったか」はGoogleログインで自動記録(手入力させない)
- 個人のGoogleアカウント(gmail.com)前提、会社のWorkspaceではない
- チーム・会社で共有(全員同じ権限=閲覧+書き込み。閲覧専用ロールは無し)
- **電波が入らない現場もあるため、オフライン対応が必須**
- 実装方式はJatLog/nutrition_trackerと同じ「ビルド不要の素のJS」+GitHub Pages
- Firebase Blazeプラン・GCP課金アカウント(カード登録)は承諾済み

実装計画の全文はセッション内のPlanファイル(`serialized-snacking-garden.md`、Claude Code
のplansディレクトリ)にある。要点はこのファイルと `README.md`/`SETUP.md` に転記済み。

## 現在の状態(2026-09-26時点)

コードは一式書き終わっている。**Firebaseプロジェクト作成・APIキー発行・GitHub Pages公開
などのブラウザ操作はまだ行われていない**(`SETUP.md`参照、Kazさん自身が行う必要がある)。
つまり「動くコードはあるが、まだ一度もデプロイ・実機確認していない」状態。

## 設計上の要点・既知の制約

### データ設計
`pins/{pinId}` → `visits/{visitId}` → `photos/{photoId}` の3階層。`createdBy`/`visitedBy`/
`uploadedBy` は必ず認証トークンから書き、Security Rules側で本人一致を強制(なりすまし防止)。
削除は `archived` フラグの論理削除のみ、物理削除は禁止(誤操作での記録消失を防ぐため)。

### オフライン対応の設計と限界(最重要)
- **ピン・訪問メモ(テキスト)**: Firestoreの `persistentLocalCache`(`docs/lib/firebase-init.js`)
  に自動で乗る。特別なキュー実装なしでオフライン読み書きができる。
- **写真**: `uploadBytes`系はオフライン自動キューが無いため、`docs/lib/offline-queue.js` に
  自前のIndexedDBキューを実装した。同期は「online イベント + 25秒ごとの定期リトライ +
  visibilitychange + 手動『今すぐ同期』ボタン」が主経路。
- **Background Sync APIについての重要な制約**: `docs/sw.js` はBackground Syncのタグ登録は
  受け取るが、実際のアップロードは行わない(開いているタブに「試みて」と伝えるだけ)。
  理由: Firebase Storageへのアップロードには有効なIDトークンが要るが、それはFirebase Auth
  SDKがページを開いている間しか自動更新しない。Service Worker単体でトークンを持ち出す
  手段(Firebase内部IndexedDBの直接読み取り等)は未検証のハックであり、壊れやすいため
  実装していない。**したがって実運用のルールは「電波のある場所でアプリを一度開く」こと。**
  これはjatlog_offlineのiOS版の運用ルールと同じ考え方(Background Syncが効かない環境では
  結局これが唯一確実な経路)。この制約はKazさんにまだ明示的に確認・合意を得ていないので、
  実機テストの段階で違和感が無いか確認すること。
- 競合解決は「同じ記録を複数人が同時編集することは想定しない・後勝ち」(jatlog_offlineと
  同じ業務前提)。

### 権限
`allowedUsers/{emailLowercase}` コレクションが唯一の許可リスト。Firestore Rulesと
Storage Rules(`firestore.exists()`のcross-service function)が両方これを参照する。
追加・削除はMVPではFirebase Console上でKazさんが直接操作する運用(管理画面は作っていない)。

### 未検証・要確認事項
- Firestore Security Rulesの `.lower()` 文字列メソッドは2026-09-26にWeb検索で存在を確認
  したが、実際のFirebase Consoleでのルールデプロイ・エミュレータテストではまだ検証していない。
  デプロイ時にエラーが出ないか要確認。
- `firebase-init.js` はFirebase JS SDK v12.4.0をCDNから読み込む設定にしている(実装計画の
  Planエージェントが調査時点で確認したURL)。デプロイ時に404等が出る場合はバージョン番号を
  最新に更新すること。
- Google Maps JavaScript APIのMap ID(Advanced Markers用)は `config.js` に未設定のプレース
  ホルダーのまま。`SETUP.md` の手順3で発行が必要。
- プロジェクト名・GitHubリポジトリ名は仮に `field_visit_map` / `field-visit-map` としている。
  Kazさんの最終決定待ち。
- 地図の初期表示位置(`config.example.js` の `defaultCenter`)はモザンビーク・リバウエ近郊を
  仮置きしている。実際の巡回先に合わせて変更すること。

## 次にやるべきこと

1. `SETUP.md` の手順1〜7をKazさんが実施(Firebaseプロジェクト作成〜Rulesデプロイ〜
   許可リスト登録)。
2. GitHub Pages公開後、`SETUP.md` の手順8の手動E2Eチェックリストを実施。特に
   「機内モードでの記録→復帰後の自動同期」はAndroid・iPhone実機の両方で確認すること
   (jatlog_offlineのHANDOVER.mdにも同様の教訓があるとおり、自動テストだけに頼らない)。
3. Background Syncの制約(上記)が実運用で問題になるようなら、SW側でのFirebase Storage
   REST APIの直接アップロード(トークン管理込み)を追加実装するかどうかをKazさんと相談する。
4. アイコン画像(`manifest.webmanifest` の `icons` は空のまま)を用意するかどうか。
   PWAとして「ホーム画面に追加」した際の見た目に影響するが、機能上は必須ではない。
