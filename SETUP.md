# セットアップ手順(Kazさん用)

Firebaseプロジェクト作成・課金紐づけ・API有効化・Firestore作成・Webアプリ登録・
Maps APIキー発行・GitHubリポジトリ作成/push/Pages公開・Firestore Rulesデプロイは
Claude Code側で完了済みです。残りはブラウザでの操作が必要な下記の項目だけです。

- プロジェクトID: `kazdr-field-visit-map`
- 公開URL: https://mameyompo-maker.github.io/field-visit-map/
- リポジトリ: https://github.com/mameyompo-maker/field-visit-map

## 残っている作業(この順番で)

### 1. Googleログインを有効化

https://console.firebase.google.com/project/kazdr-field-visit-map/authentication/providers
を開き、「Google」プロバイダを選んで有効化する(数クリックで完了)。

### 2. 承認済みドメインの追加

https://console.firebase.google.com/project/kazdr-field-visit-map/authentication/settings
の「承認済みドメイン」に `mameyompo-maker.github.io` を追加する。

### 3. Firebase Storageの開始

https://console.firebase.google.com/project/kazdr-field-visit-map/storage
を開き、「開始する」ボタンを押してデフォルトバケットを作成する(リージョンを聞かれたら
`asia-northeast1` を選ぶ)。**完了したらKazさんから教えてください。続き(Storage Rulesの
デプロイ)はこちらで行います。**

### 4. Map ID(Advanced Markers用)の発行

https://console.cloud.google.com/google/maps-apis/studio/maps?project=kazdr-field-visit-map
を開き、新しいMap IDを作成する。地図の種類は「Vector」を選ぶこと(Advanced Markersに必須)。
**発行されたMap IDをKazさんから教えてください。`docs/config.js` に反映してpushします。**

### 5. チームメンバーの許可リスト登録

https://console.firebase.google.com/project/kazdr-field-visit-map/firestore/data
を開き、コレクション `allowedUsers` を作成して、メンバー1人につき1ドキュメントを追加する
(ドキュメントID = メールアドレスを小文字で)。

```
コレクション: allowedUsers
ドキュメントID: taro.yamada@gmail.com
フィールド:
  email: "taro.yamada@gmail.com"  (文字列)
  displayName: "山田太郎"          (文字列)
  active: true                    (真偽値)
```

**Kazさん自身の分も忘れずに追加すること。** これが無いと自分もログインだけできて
「アクセス権がありません」画面になる。

## 動作確認

上記1〜5が終わったら、以下を確認する:

1. https://mameyompo-maker.github.io/field-visit-map/ を開き、Googleログイン→地図が表示される
2. 許可リスト外のメールでログインし、「アクセス権がありません」画面が出る
3. ピン追加→訪問記録(メモ+写真)→別端末/別アカウントから同じデータが見える
4. **機内モードでピン追加・メモ記録・写真撮影→電波を戻して自動同期される**
   (Android・iPhone両方。詳細は `HANDOVER.md` 参照)

## ローカル開発(任意)

```
firebase emulators:start --only firestore,storage,auth
python -m http.server 8080   # 別ターミナルで docs/ を配信
```

Auth Emulatorは実際のGoogleログインポップアップを再現しない。Rules・データ構造・
オフラインキューの検証はエミュレータで、実際のGoogleログインボタンの動作確認は
本番Firebaseプロジェクト+Kazさん自身のgmailで行うこと。
