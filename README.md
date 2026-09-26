# field_visit_map — 現場・圃場 巡回記録マップ

Googleマップの「保存した場所」では足りない、写真・メモ・訪問者(誰がいつ行ったか)を
地図上のピンに紐づけてチームで共有するためのアプリ。

- 地図: Google Maps JavaScript API(Advanced Markers)
- 認証: Firebase Authentication(Googleログイン)。「誰が行ったか」は必ずログイン情報から
  自動記録し、手入力はさせない。
- データ: Cloud Firestore(ピン・訪問記録・写真メタデータ・許可ユーザーリスト)
- 写真: Cloud Storage for Firebase
- 権限: `allowedUsers` コレクションに登録されたメールアドレスだけが読み書き可能
  (Security Rulesが唯一の防御線)
- オフライン対応: 電波が無い現場でもピン・メモ・写真の記録ができ、電波復帰時に自動同期する
  (詳細設計は `HANDOVER.md` 参照)
- 実装方式: ビルド不要の素のHTML/JS(ESモジュール)。`git push` すればGitHub Pagesに即反映
  (`projects/jatlog_offline`・`projects/nutrition_tracker` と同じ運用)

## セットアップ

初回セットアップ(Firebaseプロジェクト作成、APIキー発行、GitHub Pages公開など、
ブラウザでの手動操作が必要な手順)は `SETUP.md` を参照。

## ディレクトリ構成

```
docs/                … GitHub Pages配信元
  index.html, styles.css, app.js
  config.example.js  … config.js の雛形(config.js自体もリポジトリにコミットする。値は
                        公開前提の情報であり秘匿しない。jatlog_offlineのconfig.jsと同じ扱い)
  manifest.webmanifest, sw.js
  lib/               … Firebase/地図/オフラインキュー等の共通ロジック
  ui/                 … 画面部品(フォーム・パネル・ライトボックス)
firestore.rules, storage.rules, firebase.json, firestore.indexes.json
```

## 経緯・詳細設計

`HANDOVER.md` を参照。
