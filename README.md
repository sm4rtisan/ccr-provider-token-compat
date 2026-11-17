# 供应商输出参数兼容扩展

适用于已核对的 CCR 3.1.5 和 ai-gateway 1.0.21。独立扩展，无第三方依赖，不修改 CCR 源码。

## 安装

1. 解压整个目录，保留 plugin.json、index.cjs、settings.json，不能只复制单个文件。
2. 默认配置匹配 CCR 中名称为 openai 的供应商。如果名称不同，修改 settings.json 的 provider。填写供应商名称，不是模型名称。
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

同一供应商下所有模型都适用对应规则。不要给仍使用旧 Chat 参数的供应商开启改名规则；有混合需求时，可在 CCR 中拆成两个供应商配置。本版不支持按模型筛选，也不支持通配符和嵌套字段。

### 两种处理动作

| 动作 | 行为 |
| --- | --- |
| rename | 将 from 字段改名为 to，保留原值；原字段不存在时跳过 |
| minimum | 将 field 中小于 value 的正整数提高到 value；其余值保持原样 |

rename 的 `ifTargetExists` 目前仅支持 `keep`（默认）：目标字段已存在时保留目标值，同时删除旧字段。minimum 的 `ifMissing` 目前仅支持 `skip`（默认）：字段缺失时不会创建它。0、负数、小数及字符串不属于有效的正整数上限，不会被自动修正。

字段只支持顶层名称，如 max_tokens；不支持 request.body.max_tokens 或 metadata.user_id。配置错误、拼写错误和不支持的动作会在启动时明确报错，避免静默失效。每条规则必须明确指定协议。

### 兼容旧配置

原配置仍然可用，无需立即迁移：

```json
{
  "rules": [
    {
      "provider": "openai",
      "chatUseMaxCompletionTokens": true,
      "responsesMinOutputTokens": 16
    }
  ]
}
```

新旧规则可以分别放在同一 rules 数组里，按数组顺序执行；单条规则内不能混用两种格式。`rules: []` 可关闭所有处理。页面 config 包含 rules 时优先于 settings.json；修改后重启网关。插件只修改请求副本，不修改原请求，也不更改 metadata、消息或请求头。

## 检查连接的边界

这个扩展只处理真实网关发往供应商的请求。CCR 的“检查连接”独立构造请求，不经过此扩展，仍可能显示原参数报错。请用实际对话和供应商请求日志确认是否生效。不要将检查连接的报错误判为扩展未生效。

## 验证

已使用真实 ai-gateway 1.0.21 和本机模拟供应商验证来自 /v1/messages 的请求：Chat 与 Responses、上限 1 与 8192、匹配与不匹配的供应商，共 8 次请求全部通过。另有新旧格式兼容、顺序执行、多供应商、开关、参数优先级、原始请求不被修改、设置校验等检查。

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
