# セットアップ手順(Kazさん用)

コードは書き終わっていますが、下記はブラウザ上のコンソール操作が必要なため、
Kazさん自身で行ってください(Claude Codeからは実行できません)。

## 1. Firebaseプロジェクトの作成

1. https://console.firebase.google.com/ で新規プロジェクトを作成(例: `field-visit-map`)。
2. 「Blazeプラン(従量課金)」にアップグレードする(Storageの利用に必須)。
   - クレジットカード登録が必要。無料枠内(Storage 5GB/月、Maps API $200クレジット等)なら請求は$0見込み。
3. 左メニュー「Authentication」→「Sign-in method」→「Google」を有効化。
4. 左メニュー「Firestore Database」→「データベースの作成」(本番モード、リージョンは任意、後から変更不可なので近い場所を選ぶ)。
5. 左メニュー「Storage」→「開始する」(バケット作成。Blazeプランが前提)。
6. 左メニュー「プロジェクトの設定」→「全般」→「マイアプリ」→「ウェブアプリを追加」。
   表示される `firebaseConfig` の値(apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId)を控えておく。

## 2. 承認済みドメインの追加(Googleログイン用)

「Authentication」→「Settings」→「承認済みドメイン」に、後述のGitHub Pagesのドメイン
(例: `<username>.github.io`)を追加する。追加しないとログインボタンを押しても失敗する。

## 3. Google Maps JavaScript API

1. https://console.cloud.google.com/ で同じプロジェクトを開く(Firebaseプロジェクト = GCPプロジェクト)。
2. 「APIとサービス」→「ライブラリ」→「Maps JavaScript API」を有効化。
3. 「認証情報」→「認証情報を作成」→「APIキー」。作成したキーの制限設定で:
   - アプリケーションの制限: 「HTTPリファラー」を選び、GitHub Pagesのドメイン(`https://<username>.github.io/*`)と
     ローカル確認用(`http://localhost:*`)を追加。
   - API の制限: 「Maps JavaScript API」のみに絞る。
4. 「Google Maps Platform」→「Map Management」→「Map IDを作成」(Vector map、Advanced Markers使用に必須)。

## 4. `docs/config.js` の作成

`docs/config.example.js` をコピーして `docs/config.js` を作り、控えておいた値を書き込む
(この値はどのみちクライアントに公開される情報なので、このファイルはリポジトリに
コミットする。`.gitignore`対象なのは`.firebaserc`だけ。jatlog_offlineのconfig.jsと同じ扱い)。

## 5. GitHubリポジトリの作成とPages公開

1. 新しいpublicリポジトリを作成(例: `field-visit-map`)。
   - **注意**: リポジトリが公開でも、現場データ(ピン・写真)自体はFirestore/Storageにあり
     `firestore.rules`/`storage.rules`で保護される。静的なHTML/JS/CSSファイルが見えても
     情報漏洩にはならない(`projects/jatlog_offline`と同じ考え方)。
2. このフォルダの中身をpush(`docs/config.js`も一緒にpushする。除外されるのは`.firebaserc`だけ)。
3. リポジトリの「Settings」→「Pages」→ Source を「Deploy from a branch」、
   Branch を `main` / `docs` フォルダに設定。
4. 公開URL(`https://<username>.github.io/<repo>/`)を、手順2の承認済みドメインと
   手順3のAPIキー制限に反映する(ドメインが確定してから)。

## 6. Firebase Security Rulesのデプロイ

```
npm install -g firebase-tools    # 初回のみ
firebase login
firebase use --add               # 作成したプロジェクトIDを選ぶ(.firebaserc生成、gitignore済み)
firebase deploy --only firestore:rules,storage
```

## 7. チームメンバーの許可リスト登録

Firebase Console →「Firestore Database」→ コレクション `allowedUsers` を開き、
メンバー1人につき1ドキュメントを作成する(ドキュメントID = メールアドレスを小文字で)。

```
コレクション: allowedUsers
ドキュメントID: taro.yamada@gmail.com
フィールド:
  email: "taro.yamada@gmail.com"
  displayName: "山田太郎"
  active: true
  addedBy: "kaz自身のメール"
  addedAt: (タイムスタンプ、任意)
```

Kazさん自身の分も忘れずに追加すること。

## 8. 動作確認

- 公開URLをスマホ・PCで開き、Googleログイン→地図が表示されることを確認。
- 許可リスト外のメールでログインし、「アクセス権がありません」画面が出ることを確認。
- ピン追加→訪問記録(メモ+写真)→別端末/別アカウントから同じデータが見えることを確認。
- **機内モードでピン追加・メモ記録・写真撮影→電波を戻して自動同期されることを確認**
  (Android・iPhone両方。詳細は `HANDOVER.md` の手動E2Eチェックリスト参照)。

## ローカル開発(任意)

```
firebase emulators:start --only firestore,storage,auth
python -m http.server 8080   # 別ターミナルで docs/ を配信
```

Auth Emulatorは実際のGoogleログインポップアップを再現しない(エミュレータ独自の簡易UI)。
Rules・データ構造・オフラインキューの検証はエミュレータで、実際のGoogleログインボタンの
動作確認は本番Firebaseプロジェクト+Kazさん自身のgmailで行うこと。
