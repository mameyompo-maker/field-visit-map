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

## 現在の状態(2026-09-26 デプロイ作業中)

- Firebaseプロジェクト作成済み: `kazdr-field-visit-map`
- 課金アカウント紐づけ済み(Blaze相当。請求先「Firebaseのお支払い」)
- Firestore作成済み(Native, asia-northeast1)、Firestore Rulesデプロイ済み
- Webアプリ登録済み、`docs/config.js` に実値を反映済み
- Maps APIキー発行済み・HTTPリファラー制限設定済み(GitHub Pagesドメイン+localhost)
- GitHubリポジトリ作成・push・Pages公開済み:
  - リポジトリ: https://github.com/mameyompo-maker/field-visit-map
  - 公開URL: https://mameyompo-maker.github.io/field-visit-map/

**残りはブラウザでの手動操作が必要な項目のみ(`SETUP.md`の「残っている作業」参照)**:
Googleログイン有効化、承認済みドメイン追加、Storage開始、Map ID発行、allowedUsers登録。
このうちStorage開始とMap ID発行の2つは、Kazさんが完了させたらClaude Code側で続き
(Storage Rulesデプロイ、config.jsへのMap ID反映+push)を行う。

### CLIから自動化できなかった項目とその理由
- **Firebase AuthのGoogleプロバイダ有効化**: firebase-tools/gcloudに対応コマンドが無い
  (Identity Toolkit Admin APIを生のcurlで叩けば理論上可能だが、Claude Codeの自動モード
  分類器が「認証情報の探索」として一度ブロックしたため、安全側に倒してKazさんの手動操作にした)。
- **Firebase Storageの初回セットアップ**: `firebase deploy --only storage` が
  「Firebase Storage has not been set up... click 'Get Started'」と明示的に要求してくる。
  CLI/APIでの代替手段は見つからなかった。
- **Google Maps Map ID(Advanced Markers用)の発行**: Map Management API
  (`mapmanagement.googleapis.com`)には理論上REST APIがあるが、これも生のcurl+アクセス
  トークンが必要で、上記と同じ理由で手動操作にした。

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
- Firestore Security Rulesの `.lower()` は `firebase deploy --only firestore:rules` が
  実際に成功したことで構文的には検証済み(2026-09-26)。動作(大文字小文字を無視した
  メールアドレス一致)自体はallowedUsers登録後の実機確認で確認すること。
- `firebase-init.js` はFirebase JS SDK v12.4.0をCDNから読み込む設定にしている。デプロイ時に
  404等が出る場合はバージョン番号を最新に更新すること(まだブラウザでの実読み込みは未確認)。
- Google Maps JavaScript APIのMap ID(Advanced Markers用)は `config.js` に未設定のプレース
  ホルダーのまま。`SETUP.md` の「残っている作業4」で発行が必要。
- 地図の初期表示位置(`config.js` の `defaultCenter`)はモザンビーク・リバウエ近郊を
  仮置きしている。実際の巡回先に合わせて変更すること。

## 次にやるべきこと

1. `SETUP.md` の「残っている作業」1〜5をKazさんが実施。
2. Storage開始・Map ID発行が終わったとKazさんから連絡が来たら、Claude Code側で
   `firebase deploy --only storage` と `docs/config.js` のmapId更新+push を行う。
3. `SETUP.md` の「動作確認」を実施。特に「機内モードでの記録→復帰後の自動同期」は
   Android・iPhone実機の両方で確認すること(jatlog_offlineのHANDOVER.mdにも同様の教訓が
   あるとおり、自動テストだけに頼らない)。
4. Background Syncの制約(上記)が実運用で問題になるようなら、SW側でのFirebase Storage
   REST APIの直接アップロード(トークン管理込み)を追加実装するかどうかをKazさんと相談する。
5. アイコン画像(`manifest.webmanifest` の `icons` は空のまま)を用意するかどうか。
   PWAとして「ホーム画面に追加」した際の見た目に影響するが、機能上は必須ではない。
