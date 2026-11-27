# 供应商输出参数兼容扩展

当前版本：**2.4.5**。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

适用于已核对的 CCR 3.1.5 和 ai-gateway 1.0.21。独立扩展，无第三方依赖，不修改 CCR 源码。

## 安装

1. 解压整个目录，保留整个目录（含 diagnostics.cjs、comparison.cjs 和 diagnostics.html），不能只复制单个文件。
2. 默认配置匹配 CCR 中名称为 openai 的供应商。如果名称不同，修改 settings.json 中 match.providers。填写供应商名称，不是模型名称。
3. CCR → 扩展 → 安装 → 选择本地目录，选择整个 ccr-provider-token-compat 目录，然后保存并重启网关。
4. 停用之前删除 max_tokens 等参数的全局路由规则或路由脚本，否则扩展无法恢复已被删除的上限。
5. 用 Claude Code 发一条新消息，再在 CCR 日志中查看实际发给供应商的请求。

扩展读取 settings.json；扩展设置里的 config 如显式包含 rules，则优先使用 config.rules。修改设置后需重启网关。

## Docker

目录必须位于运行 CCR 的容器内。可将解压目录放在服务器上，例如 ./ccr-extensions/ccr-provider-token-compat，并在原 CCR 服务的 volumes 下增加：

```yaml
volumes:
  # 保留原来的挂载，新增这一行
  - ./ccr-extensions/ccr-provider-token-compat:/opt/ccr-extensions/ccr-provider-token-compat:ro
```

更新容器后，在 CCR 的扩展安装入口填写或选择容器路径：

```text
/opt/ccr-extensions/ccr-provider-token-compat
```

请选目录，不是 index.cjs。不要选浏览器所在电脑上的目录。安装路径必须保持有效，升级或重建容器后仍要保留挂载。

## 页面配置与规则

打开扩展右侧的设置齿轮，把以下内容粘贴到最下面的 **插件配置 JSON** 框，保存并重启网关。这里不需要再包一层 config。

```json
{
  "rules": [
    {
      "name": "Chat 输出参数兼容",
      "enabled": true,
      "match": {
        "providers": [
          "openai"
        ],
        "protocol": "openai_chat_completions"
      },
      "actions": [
        {
          "type": "rename",
          "from": "max_tokens",
          "to": "max_completion_tokens",
          "ifTargetExists": "keep"
        }
      ]
    },
    {
      "name": "Responses 最低输出上限",
      "enabled": true,
      "match": {
        "providers": [
          "openai"
        ],
        "protocol": "openai_responses"
      },
      "actions": [
        {
          "type": "minimum",
          "field": "max_output_tokens",
          "value": 16,
          "ifMissing": "skip"
        }
      ]
    }
  ]
}
```

### 匹配方式

- `name`：可选的规则名称，便于识别。
- `enabled`：是否启用；省略时为 true。设为 false 后不参与处理，也不要求其供应商仍存在。
- `match.providers`：一个或多个 CCR 供应商名称，不是模型名称；名称匹配忽略大小写。必须明确填写，不支持通配符。
- `match.protocol`：实际发给供应商的协议，不是客户端入口协议。支持 openai_chat_completions、openai_responses、anthropic_messages、gemini_generate_content、gemini_interactions。
- `actions`：动作数组，按顺序执行；所有符合条件的规则也按配置顺序执行，不是仅处理第一条。

同一供应商下所有模型都适用对应规则。不要给仍使用旧 Chat 参数的供应商开启改名规则；有混合需求时，可在 CCR 中拆成两个供应商配置。可用 `match.models` 按发送给供应商的模型名称精确匹配。指定模型时可省略协议，匹配该供应商下此模型的所有协议。不支持通配符和嵌套字段。

### 处理动作

| 动作 | 行为 |
| --- | --- |
| rename | 将 from 字段改名为 to，保留原值；原字段不存在时跳过 |
| delete | 删除指定的顶层 field，字段不存在时跳过 |
| minimum | 将 field 中小于 value 的正整数提高到 value；其余值保持原样 |

rename 的 `ifTargetExists` 目前仅支持 `keep`（默认）：目标字段已存在时保留目标值，同时删除旧字段。minimum 的 `ifMissing` 目前仅支持 `skip`（默认）：字段缺失时不会创建它。0、负数、小数及字符串不属于有效的正整数上限，不会被自动修正。

字段只支持顶层名称，如 max_tokens；不支持 request.body.max_tokens 或 metadata.user_id。配置错误、拼写错误和不支持的动作会在启动时明确报错，避免静默失效。未指定模型时必须明确指定协议。

### 配置更新

只支持上面的 match + actions 格式。旧的 provider、chatUseMaxCompletionTokens、responsesMinOutputTokens 配置不再接受；升级前请将页面“插件配置 JSON”替换为新示例，或填 {} 使用新版 settings.json 默认规则，否则启动会报配置错误。

`rules: []` 可关闭所有处理。页面 config 包含 rules 时优先于 settings.json；修改后重启网关。插件只修改请求副本，不修改原请求，也不更改 metadata、消息或请求头。

## 请求诊断（2.1.0）

### 打开页面

Docker 同域名下，可在已登录 CCR 的标签页直接导航到诊断地址。扩展会自动复用该标签页的登录凭证，容器须提供与管理页一致的 CCR_WEB_AUTH_TOKEN。独立标签页、桌面端或未配置环境变量时，仍可用独立诊断凭证。


桌面版可在扩展列表点击“请求诊断”的打开按钮。升级已安装的 2.0.0 时，原安装项不会自动更新 App 权限和入口，请重新选择此扩展目录安装/更新，保留原来的 rules 配置，然后保存并重启网关。安装元数据新增 apps 权限，只用于注册诊断页面入口。

Docker / 浏览器版推荐直接访问同一个 CCR 域名下的地址：

```text
http://你的CCR域名/v1/plugins/provider-token-compat
```

路径使用 /v1 前缀，适配 CCR 3.1.5 官方 Docker 中现有的网关转发规则。不要访问 /pages/home 下的地址，也不是 ccr_web_token 登录入口。若扩展列表的打开入口在容器中显示 127.0.0.1，这是容器/桌面侧地址，远程浏览器请改用上面的域名地址。

页面数据使用独立的诊断访问凭证。Docker 和远程浏览器请在“插件配置 JSON”里保留 rules，并增加 diagnostics：

```json
{
  "rules": [],
  "diagnostics": {
    "enabled": true,
    "maxEntries": 200,
    "accessKey": "替换为自己生成的至少6位随机字符串"
  }
}
```

这个示例里的 rules: [] 表示关闭兼容处理，实际使用应替换成你现有的规则数组。也可以只配置 diagnostics（不写 rules），则沿用 settings.json 中默认规则。

accessKey 需要为 6～256 个字符，可以用 `openssl rand -hex 24` 生成。重启网关后，将相同值填入诊断页面的“诊断访问凭证”框。不要填写供应商 API Key。未配置 accessKey 时，每次启动会生成临时凭证，桌面入口自动携带；浏览器版建议显式配置，方便重新连接。页面不把凭证写入本地存储；自动链接将凭证放在 # 后面，不作为 URL 查询参数发送。

### 能看到什么

- 最近处理记录：请求编号、供应商、实际协议、规则是否命中、未命中原因，以及字段变化。
- 请求编号可与 CCR 日志对照；供应商拒绝时，在确实观察到响应的情况下显示状态码。
- 规则试跑：选择供应商和实际协议，输入请求正文；可选输入临时 rules 数组。试跑不调用供应商、不更改正式配置，也不写入处理记录。
- 记录筛选、手动刷新和清空；默认最多保留 200 条，最多允许设置为 1000 条。记录仅存在内存，重启后清空。

除 model 模型名称外，请求中的其他字符串及对象字段值都不进入记录。只展示 max_tokens、max_completion_tokens、max_output_tokens、temperature、top_p、top_k 的数值变化；model 按实际模型名显示（最多 256 个字符，超出时注明截断）；其他字段只显示“内容已隐藏”。不记录请求头、完整对话或响应正文。试跑返回相同的安全摘要，不回传完整请求。

“已收到响应”只表示观察到了 HTTP 响应，不保证流式输出完整结束。网络错误、被提前拦截等没有触达响应观察入口的情况，保留“尚未观察到响应”，不会猜测成功或失败。诊断只解释本扩展的规则，不是 CCR 完整路由链路。

### 请求参数对比（2.2.0）

展开一条处理记录即可查看“请求参数对比”，按同一字段排列三栏：

1. CCR 收到时：本扩展在 beforeAuth 入口看到的正文，早于 CCR 的路由改写和协议转换；不是网络抓包，运行在本扩展之前的其他入口插件仍可能已处理请求。
2. 扩展处理前：进入本扩展供应商处理入口时的正文，可能已经过路由、协议转换和其他插件处理。
3. 扩展处理后：本扩展完成规则调整后的正文。后续的其他处理仍可能继续修改，所以不能视为供应商最终收到的内容。

页面区分新增、删除、修改、未变化和无法判断；默认隐藏确认未变化的字段，取消勾选可查看所有采集到的参数。前两栏间的变化不能单独归因于协议转换，也可能来自路由或其他插件。

model 模型名称直接显示，便于看清路由前后的模型变化。仍然不保存完整请求正文。对话、工具参数、设备信息及其他字符串或对象只保留类型/数量摘要；比较私有字段时只在内存里保留本次运行的带密钥摘要，接口和记录不输出摘要值。对象字段顺序不同不算内容变化。

每个阶段最多采集 64 个顶层字段；单个字段超过 256 KB 时只显示摘要，不判断其内容是否变化。未捕获入口、超出范围或无法比较时明确提示，不用其他阶段的内容冒充。入口快照最多保留与 maxEntries 相同的条数，超过 5 分钟在下一次请求进入时清理；请求因重试复用编号时仍保留首次捕获的入口快照。

规则试跑也提供对比，但没有真实的客户端请求，所以第一栏明确显示“未捕获”，只比较输入示例和扩展调整后的结果。诊断关闭时不捕获快照。

### 适用边界

已验证 CCR 3.1.5 默认直接网关方式和 ai-gateway 1.0.21。若 CCR 因重试、备用模型等功能切换到旧的外层转发方式，公开网关可能拦截扩展自带的页面路径；此时不要为访问页面而关闭业务功能，需要另行配置对该页面路径的转发。本扩展不会强制 CCR 切换请求处理方式。

### 关闭诊断

配置 diagnostics.enabled 为 false 并重启网关后，不再记录，也不提供诊断页面和接口，原有兼容规则仍继续生效。

## 检查连接的边界

这个扩展只处理真实网关发往供应商的请求。CCR 的“检查连接”独立构造请求，不经过此扩展，仍可能显示原参数报错。请用实际对话和供应商请求日志确认是否生效。不要将检查连接的报错误判为扩展未生效。

## 验证

已使用真实 ai-gateway 1.0.21 和本机模拟供应商验证来自 /v1/messages 的请求：Chat 与 Responses、上限 1 与 8192、匹配与不匹配的供应商，共 8 次基础请求及 1 次刻意改写的请求全部通过。另有旧格式拒绝检查、顺序执行、多供应商、开关、参数优先级、原始请求不被修改、设置校验等检查。

没有使用真实 API Key，没有访问真实供应商，也没有在你的 Docker 容器内安装。

可运行基础检查：

```sh
node --test test.cjs
```

要重复完整验证，准备已安装运行依赖的 @the-next-ai/ai-gateway 1.0.21，然后执行：

```sh
CCR_TEST_GATEWAY_ENTRY=/absolute/path/to/ai-gateway/dist/index.js node --test test.cjs
```

完整验证需要允许监听本机临时端口；未设置环境变量时会明确跳过真实网关验证。

## 停用

在 CCR 扩展页关闭或删除本扩展，再重启网关。无需还原 CCR 源码。

## 版本维护

版本号统一维护在 `plugin.json` 的 `version`，运行时的扩展信息直接读取它，不另外硬编码。每次发布都需要更新该值和 CHANGELOG.md；README 顶部当前版本同步更新。

- 修复问题且配置不变：增加末位版本号，例如 2.1.0 → 2.1.1。
- 新增向下兼容的能力：增加中间版本号，例如 2.1.0 → 2.2.0。
- 删除配置支持等不兼容改动：增加首位版本号，例如 2.0.0 → 3.0.0。

2.0.0 移除了旧配置；2.1.0 新增诊断，原有新版规则仍兼容。升级时先把 CCR 页面中的旧配置改为新版 match + actions。CCR 3.1.5 扩展列表没有独立的版本列；可在本目录 plugin.json 或 README 查看版本，填写版本号并不会自动增加 CCR 的显示栏目。
