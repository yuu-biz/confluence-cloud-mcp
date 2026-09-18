# Confluence Cloud MCP

Confluence Cloud REST API v1 and v2を、Claude Desktopから使えるローカルstdio MCPサーバーとして提供します。検索、ページ本文、Space、階層、添付、コメント、版履歴、主要な更新操作を、LLMが作業の流れに合わせて選べる粒度のToolにまとめています。

認証情報はローカル環境変数、またはClaude Desktop Extensionのsecure configurationから受け取ります。サーバーはstdoutをMCP protocol専用に使うため、診断ログはstderrへ出力します。

## Requirements

- Node.js 20 or newer
- Confluence Cloud site
- Atlassian account email
- Atlassian API token
- Claude Desktop (stdio configuration or `.mcpb` Extension)

API tokenはAtlassianの[API tokens page](https://id.atlassian.com/manage-profile/security/api-tokens)で作成します。Confluence CloudのBasic Authは、メールアドレスとAPI tokenを使う方式です。Tokenには必要最小限の権限を持つAtlassianアカウントを使ってください。

## Quick start with Node

```powershell
git clone https://github.com/yuu-biz/confluence-cloud-mcp.git
cd confluence-cloud-mcp
npm install
npm run build:bundle
```

`CONFLUENCE_BASE_URL`、`CONFLUENCE_EMAIL`、`CONFLUENCE_API_TOKEN`を設定してサーバーを起動します。PowerShellでは次のように設定できます。

```powershell
$env:CONFLUENCE_BASE_URL = "https://example.atlassian.net"
$env:CONFLUENCE_EMAIL = "user@example.com"
$env:CONFLUENCE_API_TOKEN = ""
node dist/index.js
```

`.env.example`をコピーして使う場合も、`.env`はGitへ追加しないでください。このプロジェクトはdotenvを読み込まないため、Claude Desktopまたは起動環境から環境変数を渡します。

## Claude Desktop stdio configuration

Claude Desktopの設定ファイルに、次のエントリを追加します。`args`はclone先の絶対パスへ変更し、空の`CONFLUENCE_API_TOKEN`にはローカル設定だけで実際のtokenを入力してください。公開リポジトリの設定例にはtokenを記載しません。

```json
{
  "mcpServers": {
    "confluence-cloud": {
      "command": "node",
      "args": ["C:\\path\\to\\confluence-cloud-mcp\\dist\\index.js"],
      "env": {
        "CONFLUENCE_BASE_URL": "https://example.atlassian.net",
        "CONFLUENCE_EMAIL": "user@example.com",
        "CONFLUENCE_API_TOKEN": "",
        "CONFLUENCE_ALLOW_DESTRUCTIVE_OPERATIONS": "false",
        "CONFLUENCE_ALLOW_RAW_WRITE": "false",
        "CONFLUENCE_ALLOW_LOCAL_FILE_UPLOAD": "false"
      }
    }
  }
}
```

Claude Desktopを再起動してから、`confluence_search`でCQL検索を試してください。

## Claude Desktop Extension (`.mcpb`)

Extensionは、Node.jsを別途用意せずClaude DesktopへローカルMCPサーバーを導入するためのパッケージです。

```powershell
npm run build:mcpb
```

生成された`dist/confluence-cloud-mcp.mcpb`をClaude Desktopへドラッグするか、Extensionのインストール画面で選択します。設定画面で次を入力します。

- Confluence site URL: `https://example.atlassian.net`
- Atlassian email: `user@example.com`
- Atlassian API token: Extensionのsensitive fieldへ入力
- Destructive operations: 通常は無効
- Raw write requests: 通常は無効
- Local file upload: 通常は無効

Extension manifestはMCPB manifest v0.4を使い、API tokenを`sensitive: true`のuser configurationから環境変数として渡します。MCPBにはOS-level sandboxがないため、write系の安全制御はサーバー側でも行っています。

High-level Toolを通常優先してください。サーバー内部でpagination、階層再構成、複数API呼び出しを処理するため、Claude DesktopからのTool Callを減らせます。Primitive Toolは、1リソース・1階層だけが必要な場合、cursorを自分で制御したい場合、High-level Toolが公開していないフィールドを使いたい場合に使います。

| High-level Tool               | 集約する処理                                                                |
| ----------------------------- | --------------------------------------------------------------------------- |
| confluence_get_content_tree   | v2 descendantsのcursor pagination、root取得、階層再構成、budget内でのrender |
| confluence_search_and_fetch   | query→CQL変換、v1 search、上位ページのv2本文取得                            |
| confluence_get_page_context   | ページ本文・current versionと、指定したancestors / attachments / comments   |
| confluence_get_space_overview | space key解決、Space metadata、homepage/root以下のcontent tree              |
| confluence_get_comment_thread | コメント本体とv2 child commentsのreply tree                                 |

### Content treeのoutput mode

`confluence_get_content_tree`（および`confluence_get_space_overview`）は、node objectの羅列ではなくインデント済みテキストを返します。1行 = 1 node、インデント = 階層、末尾の`/` = folder、`[id]`は後続呼び出し用のcontent idです。`parentId`や`childPosition`は階層から復元できるためcompact outputには含めません。

- `compact`（default）: output budgetに収まる最も深い表示を返します。収まらない場合はbranchを切り捨てる前にdepthを下げるため、branchは一覧から消えません。
- `outline`: 直下の子だけを子数付きで返す「地図」。内部ではdepth 2のdescendantsを1回読むだけで、branchごとのAPI呼び出しは発生しません。巨大・未知の階層はまずこれを取り、必要なbranchだけ`compact`で展開します。
- `detailed`: 従来どおりのnode object。`parentId` / `childPosition` / `status`が必要なときだけ使います。

### Fetched / rendered / omitted と truncation

`status`はMCPが取得した量とClaudeへ返した量を分けて報告します。

- `fetchedItems` / `renderedItems` / `omittedItems`: 取得数、実際にrenderした数、省略された数
- `truncated` と `truncationReasons`: `output_budget`（renderで省略）、`max_items`、`pagination_limit`、`api_error`
- `omittedBranches`: 省略したbranchの`id` / `title` / `type` / `fetchedDescendants`。関係のありそうなbranchだけ`root_id`に指定して追加取得できます
- `outputBudget`: `requestedChars`（指定値）、`effectiveChars`（実際に使われた値）、`hardCapChars`（サーバー上限50,000）

`max_chars`は1,000〜50,000の範囲にクランプされます。指定値と実効値が異なる場合も`status.outputBudget`で確認できます。

### Search mode

`confluence_search_and_fetch`はCQLを書かずに`query`を渡せます。`search_mode`は`auto`（default）で、`title = "..."`（完全一致）→ `title ~ "...*"`（前方一致）→ `text ~ "..."`（全文）の順に試し、最初にhitした時点で止まります。full-text検索はtokenizeされるため、識別子や型番のように正確なtitleが分かっている場合はこの順序が有効です。`exact_title` / `title_prefix` / `full_text`で固定でき、`cql`は手書きクエリ用のescape hatchです。実際に使われたCQLは`strategy.cqlUsed`に入ります。

## Tool overview

| Tool                                                                    | Purpose                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `confluence_search`                                                     | CQLでv1検索。IDが不明なときの入口                           |
| `confluence_list_pages`                                                 | v2でページ一覧、Space・タイトル・status・cursor検索         |
| `confluence_get_page`                                                   | ページ本文、labels、properties、operations、likes、versions |
| `confluence_get_content`                                                | v1の汎用content取得とexpand                                 |
| `confluence_list_spaces` / `confluence_get_space`                       | Spaceの一覧・詳細                                           |
| `confluence_get_folder` / `confluence_create_folder`                    | Folderの詳細取得・作成                                      |
| `confluence_list_children`                                              | PageまたはFolderの直接の子                                  |
| `confluence_list_descendants`                                           | PageまたはFolder以下の子孫とdepth                           |
| `confluence_get_ancestors`                                              | PageまたはFolderの親階層                                    |
| `confluence_list_attachments` / `confluence_get_attachment`             | 添付ファイルの一覧・メタデータ                              |
| `confluence_list_comments` / `confluence_get_comment`                   | footer / inline commentの一覧・詳細                         |
| `confluence_list_versions` / `confluence_get_page_version`              | v2のページ版履歴                                            |
| `confluence_get_content_history`                                        | v1の汎用content history                                     |
| `confluence_create_page`                                                | Page作成（published / draft、storage / ADF）                |
| `confluence_update_page`                                                | explicit version number付きPage更新                         |
| `confluence_update_page_title`                                          | titleだけの更新                                             |
| `confluence_create_comment` / `confluence_update_comment`               | footer commentの作成・更新                                  |
| `confluence_create_inline_comment` / `confluence_update_inline_comment` | inline commentの作成・更新・resolve                         |
| `confluence_upload_attachment`                                          | opt-inでローカルファイルをPageへアップロード                |
| `confluence_delete_page`                                                | opt-inでtrash / purge                                       |
| `confluence_raw_request`                                                | allowlisted pathだけの未ラップAPIアクセス                   |

典型的な流れは、Space全体の把握には confluence_get_space_overview、ページ検索と本文確認には confluence_search_and_fetch、ページ理解には confluence_get_page_context、階層取得には confluence_get_content_tree（大きい場合はまず output_mode=outline）を使い、1階層だけ必要なときや cursor を自分で制御したいときだけ confluence_list_children などのPrimitiveを使う形です。

## Pagination and response size

Primitiveのv2一覧系APIはConfluenceのcursor paginationに合わせ、レスポンスの next_cursor を返します。High-level Toolは、指定budgetに達するまでcursorをMCP内部で消費します。v1 CQL searchは start と next_start を使い、confluence_search_and_fetch は指定した fetch_top だけを本文取得します。 High-level Toolのcursor消費には内部上限（1呼び出しあたり最大20ページ）があり、打ち切った場合は status.truncationReasons に pagination_limit が入ります。

Tool responseはデフォルトで12,000文字に抑え、`max_chars`で最大50,000文字まで調整できます。ページ本文など大きい値は縮約されるため、必要な本文representationを指定して個別取得してください。

API clientは429と一時的な5xxを指数バックオフと`Retry-After`に従って最大3回再試行します。401、403、404、権限エラーは、statusと安全な説明をTool errorとして返します。Credentials、Authorization header、環境変数値はログやTool responseへ出しません。

## Safety controls

デフォルトでは次が無効です。

- `CONFLUENCE_ALLOW_DESTRUCTIVE_OPERATIONS=false`: page delete、purge、raw DELETEを無効化
- `CONFLUENCE_ALLOW_RAW_WRITE=false`: raw POST / PUT / PATCH / DELETEを無効化
- `CONFLUENCE_ALLOW_LOCAL_FILE_UPLOAD=false`: ローカルファイル添付を無効化

有効化しても、破壊的操作・raw write・file uploadはTool inputの`confirm: true`が必要です。raw toolは完全URL、別ホスト、`..`、query string入りのpathを拒否し、`/wiki/api/v2/`または`/wiki/rest/api/`のrelative pathだけを受け付けます。

標準では`CONFLUENCE_BASE_URL`を`https://*.atlassian.net`に制限します。管理されたcustom domainを使う場合だけ、`CONFLUENCE_ALLOW_CUSTOM_DOMAIN=true`を明示してください。

## Development

```powershell
npm install
npm run check
npm test
npm run build
npm run build:bundle
```

実Confluence credentialを使わないunit testで、Basic Auth、query encoding、rate-limit retry、API error、pagination、raw path safety、response size boundを検証します。stdioの手動確認には、ビルド後に[MCP Inspector](https://github.com/modelcontextprotocol/inspector)を使えます。

```powershell
npx @modelcontextprotocol/inspector node dist/index.js
```

## Deliberate limitations

- OAuth、Atlassian Connect、Forgeの認証は実装していません。ローカル用途のemail + API token Basic Authに限定しています。
- named toolはPage / Folder階層を中心にし、全REST endpointを1:1では公開していません。未ラップAPIは安全なraw toolで補完します。
- 添付のダウンロード内容をMCP responseへ埋め込む機能はありません。現状は一覧・メタデータ・opt-in uploadです。
- Blog post、whiteboard、databaseなどPage以外のcontentは、必要に応じてraw toolまたはv1 `confluence_get_content`を使います。
- ページ更新の競合は自動マージせず、呼び出し側が最新version numberを指定します。
- Space permission、admin key、永久削除など高権限操作はnamed toolとして追加していません。権限が必要なAPIはraw toolの追加実装と同じpath/method allowlistを通してください。

## Official references

- [Confluence Cloud REST API v2](https://developer.atlassian.com/cloud/confluence/rest/v2/)
- [Confluence Cloud REST API v2 introduction and cursor pagination](https://developer.atlassian.com/cloud/confluence/rest/v2/intro/)
- [Confluence Cloud REST API v1 search](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-search)
- [Confluence Cloud REST API v2 pages](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)
- [Atlassian: Using the REST API](https://developer.atlassian.com/cloud/confluence/using-the-rest-api/)
- [MCP TypeScript SDK server and stdio transport](https://ts.sdk.modelcontextprotocol.io/server)
- [MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)

## License

MIT. See [LICENSE](LICENSE).
