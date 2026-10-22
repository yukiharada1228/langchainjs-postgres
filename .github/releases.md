# 自動リリース

通常の変更PRをmainへSquash mergeすると、その後の手動リリース操作は不要です。
バージョン番号、リリースPR、CHANGELOG、タグ、GitHub Release、npmの`latest`を自動更新します。

## リリースのタイミング

1. mainのCIがすべて成功すると、Releaseワークフローが前回リリース以降の変更を判定します。
2. リリース対象があれば、Release PleaseがバージョンとCHANGELOGだけを更新するPRを作成します。
3. リリースPRも通常のCI・脆弱性検査を通し、GitHub AppがSquash mergeを予約します。
   必須チェックを省略したり、ブランチ保護を迂回したりはしません。
4. マージ後のmain CI成功を確認してタグとGitHub Releaseを作成します。
5. Publish npmがそのタグのソースをビルドし、OIDC認証でnpmへ公開します。
   `latest`とSHA-512の一致を確認して完了です。npmの反映には数分かかることがあります。

短時間に複数の変更が入れば、未マージのリリースPRにまとめられます。
現在のバージョンがnpmへ公開されるまでは、次のリリースPRを作成しません。
失敗やイベント取りこぼしに備え、Releaseは毎時17分、Publish npmは毎時37分にも再確認します。
GitHubのスケジュール実行には遅延があり得ます。Actionsから手動再実行もできますが、通常は不要です。
公開済みバージョンは再発行せず、レジストリ障害を「未公開」と判定しません。

## バージョンの判定

PRタイトルはConventional Commits形式にします。CIが形式を検証し、Squash commitに引き継ぎます。
番号の指定や手動の`npm version`、タグ作成は不要です。

| PRタイトル                                                                                | 更新                       | 例（現在0.2.0の場合） |
| ----------------------------------------------------------------------------------------- | -------------------------- | --------------------- |
| `fix: ...`、`perf: ...`、`security: ...`                                                  | patch                      | 0.2.1                 |
| `build: ...`、`refactor: ...`、`revert: ...`                                              | patch                      | 0.2.1                 |
| `chore(deps): ...`（実行時依存の更新）                                                    | patch                      | 0.2.1                 |
| `feat: ...`                                                                               | minor                      | 0.3.0                 |
| `fix!: ...`などの`!`付きタイトル、またはPR本文の`BREAKING CHANGE:`                        | 0.xはminor、1.x以降はmajor | 0.3.0                 |
| `docs: ...`、`ci: ...`、`test: ...`、`style: ...`、通常の`chore:`、`chore(deps-dev): ...` | 単独ではリリースしない     | 更新なし              |

複数の変更がある場合は最も大きい更新を採用します。スコープも使用できます（`fix(search): ...`）。
互換性の意味までは機械判定できないため、破壊的変更には`!`または`BREAKING CHANGE:`を記載します。
0.xから1.0.0へ安定版化する場合に限り、PR本文に`Release-As: 1.0.0`を記載します。
リリースノートは変更の種類ごとに自動生成されます。

## 認証と権限

- 既存の`PATCH_BOT_APP_ID`と`PATCH_BOT_PRIVATE_KEY`を使い、Appのトークンを実行ごとに発行します。
  通常のCIが自動起動するため、Bot PRのワークフロー承認は不要です。
- npmのTrusted Publisherはリポジトリ`yukiharada1228/langchainjs-postgres`、
  ワークフロー`publish.yml`、Environment `npm`に限定します。
  Environmentのデプロイ対象はmainのみで、毎回の承認は要求しません。
- npmの長期トークンやローカルのログイン情報をGitHub Secretsへ登録しません。
- ビルドは書き込み権限・OIDC権限のない別ジョブで行います。
  公開ジョブは同じrunの成果物だけを受け取り、依存インストールやライフサイクルスクリプトを実行しません。
- 公開対象はmainの祖先にあるタグとし、そのコミットの全CI成功を再確認します。

## 停止・復旧

Actions Variable `RELEASE_AUTOMATION_ENABLED=false`で新たな自動処理を停止できます。
すでにauto-merge予約済みのリリースPRは、PR画面で予約も解除してください。
リリースPRの`no-automerge`ラベルは新たな予約を拒否します。

一時的なnpm/GitHub障害は毎時の処理で再確認します。恒久的な設定エラーやテスト失敗は
Actionsの失敗として残り、保護を無効化せずに停止します。修正後は通常のCIまたは毎時処理で再開します。
すでに同じバージョンが異なる内容で公開されている場合は自動上書きせず、原因調査が必要です。

初期設定を作り直す場合は、npm側の信頼関係とGitHub Environmentを設定してから
`RELEASE_AUTOMATION_ENABLED=true`にします。npmの初回設定時だけ本人認証が必要です。

参考: [Release Please](https://github.com/googleapis/release-please)、
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、
[GitHubの自動実行とトークン](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。
