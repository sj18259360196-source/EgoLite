# Ego 站点经验

本 Skill 同时读取两类经验。

- `references/site-patterns/` 保存从 `web-access` 迁移来的简洁 Markdown 经验，由本 Skill 维护。
- 配套 `ego-browser` Skill 的原生经验通过 `site.learnContext(url)` 读取。本 Skill 不修改那个目录。

两类经验都只提供先验信息，实际页面结果始终优先。

## 匹配本 Skill 的经验

URL 未知时，把用户输入交给匹配脚本。它会按域名与别名查找。

```powershell
node <skill-dir>\scripts\match-site.mjs "用户输入"
```

```bash
node <skill-dir>/scripts/match-site.mjs "用户输入"
```

`<skill-dir>` 是当前 `SKILL.md` 所在目录。URL 已知后，也把完整 URL 交给同一脚本。脚本没有输出代表当前没有匹配经验。

## 读取 Ego 原有经验

选择任务空间后，在 Ego 脚本中读取上下文。

```js
const context = await site.learnContext(url)
if (context.exists) {
  console.log(JSON.stringify({
    knowledge: context.knowledge,
    tools: context.tools,
  }, null, 2))
}
```

`knowledge` 保存说明文档内容。`tools` 中的每个条目都带有自己的 `siteId`、`toolName`、`toolType`、参数与返回值。多个经验包可能同时匹配，调用时使用所选工具条目上的 id。

```js
const tool = context.tools.find(
  (item) => item.toolType === 'node' && item.toolName === 'search_and_extract',
)
if (!tool) throw new Error('没有匹配的站点工具')
const result = await site.runTool(tool.siteId, tool.toolName, {
  query: 'example',
  maxResults: 5,
})
```

浏览器侧工具运行在当前页面。调用前确认当前页面域名与工具匹配。

```js
const tool = context.tools.find(
  (item) => item.toolType === 'browser' && item.toolName === 'post_from_active_element',
)
if (!tool) throw new Error('没有匹配的浏览器站点工具')
const result = await site.runBrowserTool(tool.siteId, tool.toolName, {})
```

## 本 Skill 的经验格式

文件名使用主域名，例如 `example.com.md`。

```markdown
---
domain: example.com
aliases: [Example, 示例站点]
updated: 2026-08-30
---

## 平台特征

已经验证的架构、加载方式与登录要求。

## 有效模式

已经验证的 URL 模式、语义定位方式与等待条件。

## 已知陷阱

失败路径、出现条件与发现日期。
```

任务成功后，只有发现可复用的新事实时才新增或更新 `references/site-patterns/<domain>.md`。不要为了记录经验修改配套 `ego-browser` Skill。

## 记录边界

可以记录页面架构、内容加载方式、稳定 URL 模式、语义定位方式、等待条件、登录要求、频率限制与已验证的失败路径。

不要记录未经验证的推测、当前 snapshot 生成的 `@N` 或 `ref=N`、完整签名 URL、会话 token、cookie、账号信息、个人数据、单次页面坐标和临时 target id。

说明文档写清发现日期。使用经验失败时回到通用浏览器流程，完成当前任务后再更新过时内容。
