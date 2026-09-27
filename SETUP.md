# セットアップ手順(Kazさん用)

セットアップはほぼ完了しています(2026-09-27時点)。
**残っているのは「許可リストへの登録」だけです。**

- プロジェクトID: `kazdr-field-visit-map`
- 公開URL: https://mameyompo-maker.github.io/field-visit-map/
- リポジトリ: https://github.com/mameyompo-maker/field-visit-map

### 完了済み
Firebaseプロジェクト作成・課金紐づけ・API有効化・Firestore作成・Webアプリ登録・
Maps APIキー発行・GitHubリポジトリ作成/push/Pages公開・Firestore Rulesデプロイ・
Googleログイン有効化・承認済みドメイン追加・Storage開始とRulesデプロイ・Map ID発行。

## 残っている作業: チームメンバーの許可リスト登録

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

**Kazさん自身の分(`mameyompo@gmail.com`)も忘れずに追加すること。** これが無いと
自分もログインだけできて「アクセス権がありません」画面になる。

ドキュメントIDがメールアドレスそのもの(小文字)である点に注意。ここが一致しないと
登録したことになりません。登録後にアプリの「登録済みなら、もう一度確認」ボタンを
押せば、ログインし直さなくても反映されます。

## 動作確認

1. https://mameyompo-maker.github.io/field-visit-map/ を開き、Googleログイン→地図が表示される
2. ＋ボタン→照準を合わせて「ここに追加」→ピンが地図に出る
3. ピンをタップ→「訪問を記録する」→メモとカメラ撮影→一瞬で閉じ、履歴に写真が出る
4. 「一覧」ボタン→検索でピンが絞り込める
5. 許可リスト外のメールでログインし、「アクセス権がありません」画面が出る
6. 別端末/別アカウントから同じデータが見える
7. **機内モードでピン追加・メモ記録・写真撮影→電波を戻して自動同期される**
   (Android・iPhone両方。詳細は `HANDOVER.md` 参照)
   - 機内モード中は上部に「オフラインです(保存待ち n 件)」の帯が出る
   - 圏内に戻すと自動で送信され、帯が消える。消えないときは「今すぐ同期」を押す

## ローカル開発(任意)

```
firebase emulators:start --only firestore,storage,auth
python -m http.server 8080   # 別ターミナルで docs/ を配信
```

Auth Emulatorは実際のGoogleログインポップアップを再現しない。Rules・データ構造・
オフラインキューの検証はエミュレータで、実際のGoogleログインボタンの動作確認は
本番Firebaseプロジェクト+Kazさん自身のgmailで行うこと。
