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

## 現在の状態(2026-09-27 全体見直し・再デプロイ済み)

デプロイ後の総点検で、起動・保存まわりに致命的な不具合が複数見つかり、すべて修正して
push済み(コミット `8a9e89a`)。詳細は下の「2026-09-27に直した不具合」を参照。
**Kazさんの手元でまだ確認が取れていないのは「allowedUsers への登録」だけ**(下記)。

## 現在の状態(2026-09-26 デプロイ作業)

- Firebaseプロジェクト作成済み: `kazdr-field-visit-map`
- 課金アカウント紐づけ済み(Blaze相当。請求先「Firebaseのお支払い」)
- Firestore作成済み(Native, asia-northeast1)、Firestore Rulesデプロイ済み
- Webアプリ登録済み、`docs/config.js` に実値を反映済み
- Maps APIキー発行済み・HTTPリファラー制限設定済み(GitHub Pagesドメイン+localhost)
- GitHubリポジトリ作成・push・Pages公開済み:
  - リポジトリ: https://github.com/mameyompo-maker/field-visit-map
  - 公開URL: https://mameyompo-maker.github.io/field-visit-map/

Kazさんの手動操作が必要だった項目(Googleログイン有効化、承認済みドメイン追加、
Storage開始、Map ID発行)は2026-09-26に完了。Storage Rulesのデプロイと
`docs/config.js` へのMap ID反映もこちらで実施済み。
**残るは `allowedUsers` への登録のみ(2026-09-27時点で未確認)。**

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

## 2026-09-27に直した不具合(同じ失敗を繰り返さないための記録)

いずれもデプロイ後の通し点検で見つけたもの。**症状が「読み込み中のまま進まない」に
集約されるため、原因の切り分けを誤りやすい。**

1. **許可リストを読めずに画面が固まる(最優先で直した本命)**
   `firestore.rules` の `allowedUsers` が `allow read: if isAllowed()` だけだったため、
   まだ登録されていない人が自分の行を読むと permission-denied になる。`auth.js` は
   それを握りつぶして「判定保留(null)」を返し、`app.js` は判定保留を「読み込み中」に
   割り当てていたため、**永久に読み込み中のまま。ログイン画面にも戻れない。**
   → ルールで「自分の1行だけは誰でも読める」ようにし、auth.js側も
   `checking / allowed / denied / error` の4状態に確定させて、判定不能を作らないようにした。

2. **オフラインで保存ボタンが戻らない**
   Firestoreの `setDoc`/`updateDoc` が返すPromiseは**サーバーに届くまで解決しない**。
   ローカル反映は即座に終わっているのに `await` していたため、圏外では永久に
   「保存中…」のまま。→ 書き込みは await せず、ローカル採番したIDを即座に返す方式に変更。
   未送信ぶんはステータスバーの件数で見せる。**この挙動はFirestoreの仕様であり、
   オフライン前提のアプリでは絶対に await してはいけない。**

3. **ピン詳細パネルの写真が消える**
   ピンが更新されるたびにパネル全体を `innerHTML` で作り直しており、写真の入れ物も
   新品になる。写真は別購読から後追いで流し込むため、再送が無い限り二度と埋まらない。
   → 見出しは `textContent` で部分更新し、写真は `photosByVisit` の控えから埋め直す。

4. **写真の幅・高さが常に0で保存される**
   `bitmap.close()` の**後**に `bitmap.width` を読んでいた(仕様上closeで0になる)。

5. **オフラインでアプリが起動すらできない**
   `sw.js` がgstatic配信のFirebase SDKをキャッシュしていなかったため、圏外では
   `import` が失敗してアプリが起動しない。→ SDK4本もキャッシュ対象に追加。
   Playwrightで通信を完全遮断して起動することを確認済み(2026-09-27)。

6. **地図の読み込み失敗が起動処理全体を巻き込む**
   `ensureMapStarted()` が地図を先に await していたため、圏外だと同期も一覧も動かない。
   → データ購読・同期・一覧を先に立ち上げ、地図は最後に、失敗しても他に影響しない形に。
   地図が出せないときは一覧から記録を続けられる導線(`#mapFallback`)を用意した。

7. **Service Workerの版数を上げ忘れると全端末が古いまま**
   実際にこれで詰まった。→ `index.html` で `controllerchange` を拾って一度だけ自動
   再読み込みするようにした。版数さえ上げれば利用者の操作は不要になる。
   ただし**版数を上げる作業自体は自動化されていない**ので、`docs/` を触ったら
   `sw.js` の `CACHE` を必ず上げること(現在 `field-visit-map-v3`)。

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

### 検証済み・未検証の切り分け(2026-09-27時点)

**自動テストで確認できたこと**(Playwright + システムのMicrosoft Edgeを使用。
`chromium.launch({ channel: 'msedge' })` にしないとブラウザのダウンロードが要る):
- 全モジュールが実際に読み込まれ、実行時エラーが出ないこと
- 新規訪問者がログイン画面に到達すること(画面の重なりが無いこと)
- **通信を完全遮断した状態でもアプリが起動し、ログイン画面まで到達すること**
- Service Workerが23ファイル(Firebase SDK4本を含む)をキャッシュすること
- スマホ幅(390px)で横スクロールが発生しないこと

**まだ人の手でしか確認できないこと**(Googleログインが必要なため):
- 実際のログイン → 地図表示 → ピン追加 → 訪問記録 → 写真添付の通し動作
- 機内モードでの記録 → 復帰後の自動同期(Android・iPhone実機の両方で)
- Storage Rulesが許可リスト外からの直アクセスを拒否すること

### その他の要確認事項
- 地図の初期表示位置(`config.js` の `defaultCenter`)はモザンビーク・リバウエ近郊を
  仮置き。ただし初回起動時は現在地に自動で寄せ、2回目以降は前回の表示位置を
  localStorage(`fvm.view`)から復元するので、実害は初回のみ。
- Firebase JS SDKは v12.4.0 固定。上げるときは `docs/lib/firebase-init.js` と
  **`docs/sw.js` の `CDN_FILES`** の両方を直すこと(片方だけだとオフラインで起動しなくなる)。

## 次にやるべきこと

1. **`allowedUsers/mameyompo@gmail.com` がFirestoreに存在するか確認する(未確認)。**
   無ければアプリは「アクセス権がありません」画面になる。Firebase Consoleの
   Firestore Database → コレクション `allowedUsers` → ドキュメントID
   `mameyompo@gmail.com`(小文字)→ フィールド `active`(boolean)= true。
   ※ドキュメントIDがメールアドレスそのもの。ここを間違えると一致しない。
   ※CLIにFirestoreのドキュメントを読み書きするコマンドは無く、Claude Code側からは
   確認も作成もできない(生のcurl+アクセストークンは自動モード分類器にブロックされる)。
2. Kazさんの実機で通し動作の確認(上記「まだ人の手でしか確認できないこと」)。
3. 機内モードでの記録→復帰後の自動同期を、Android・iPhone実機の両方で確認する
   (jatlog_offlineのHANDOVER.mdの教訓どおり、自動テストだけに頼らない)。
4. チームメンバーのメールアドレスを `allowedUsers` に追加し、Kazさん以外の1名で
   書き込みテストを行う。
5. Background Syncの制約(上記)が実運用で問題になるようなら、SW側でのFirebase Storage
   REST APIの直接アップロード(トークン管理込み)を追加実装するかどうかをKazさんと相談する。
