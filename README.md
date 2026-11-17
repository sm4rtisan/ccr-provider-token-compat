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

## 处理范围

默认 settings.json：

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

- 对该供应商下所有模型生效，不根据模型名称判断。
- 根据转换完成后实际选择的供应商协议处理，不根据 Claude Code 的入口协议推测。
- Chat：删除旧的 max_tokens，并将原值放入 max_completion_tokens。如新字段已经存在，保留新字段的值。
- Responses：仅把大于 0、小于 16 的整数 max_output_tokens 提高到 16；8192 等正常值不变。
- 未传输出上限时不主动添加；无效值不偷偷修正。
- 其他协议、其他供应商、消息内容和 metadata 不变。
- 支持 CCR 3.1.5 的供应商内部别名和密钥池名称。

同一供应商下所有模型应支持对应选项。若有模型仍要求旧 Chat 参数，请将 chatUseMaxCompletionTokens 设为 false，或在 CCR 中建立独立的供应商配置后分别设置。

## 检查连接的边界

这个扩展只处理真实网关发往供应商的请求。CCR 的“检查连接”独立构造请求，不经过此扩展，仍可能显示原参数报错。请用实际对话和供应商请求日志确认是否生效。不要将检查连接的报错误判为扩展未生效。

## 验证

已使用真实 ai-gateway 1.0.21 和本机模拟供应商验证来自 /v1/messages 的请求：Chat 与 Responses、上限 1 与 8192、匹配与不匹配的供应商，共 8 次请求全部通过。另有参数优先级、原始请求不被修改、设置校验等检查。

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
