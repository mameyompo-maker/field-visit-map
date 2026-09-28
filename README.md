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
- 写真から記録: 写真を選ぶとEXIFの撮影地点を読み、近くの登録済みの場所を候補に出す
  - 位置情報が無い写真では、理由を示したうえで現在地を使う。**スマホから選んだ写真は
    OSがGPSを取り除くため読めないのが普通**(HANDOVER.md「位置情報が読めない理由」)
  (「ここですか?」)。近くに無ければ撮影地点に新しい場所を作る。撮影日時も記録に使う
- 書き出し: 記録を端末にダウンロードして他の道具へ持ち出せる。地図はKML(Google
  マイマップにそのまま読み込める)、記録はCSV/Markdown/JSON、写真は実体ごとZIP
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
  lib/               … Firebase/地図/オフラインキュー/書き出し等の共通ロジック
    export.js        … KML・CSV・Markdown・JSON・GeoJSONの生成とダウンロード
    zip.js           … 無圧縮ZIPの書き出し(外部ライブラリを使わない理由は同ファイル冒頭)
    exif.js          … 写真から撮影地点・撮影日時を読む(自前のEXIF解析)
    geo.js           … 2地点の距離(候補の絞り込みに使う)
  ui/                 … 画面部品(フォーム・パネル・ライトボックス・書き出し画面)
firestore.rules, storage.rules, firebase.json, firestore.indexes.json
```

## 経緯・詳細設計

`HANDOVER.md` を参照。
