# Ego 适配参考

只有任务需要真实浏览器时读取这份参考。普通搜索、静态抓取和 `curl` 不需要进入 Ego。这里的调用映射针对 `ego-browser` 1.2.x，准确签名与控制权规则以当前安装的 `ego-browser` Skill 为准。

## 调用方式

Windows PowerShell 用 here-string 把 JavaScript 送入标准输入。

```powershell
@'
let task
let completed = false
let preserveTask = false
try {
  task = await taskSpaces.useOrCreate('inspect example')
  const url = 'https://example.com'
  const learned = await site.learnContext(url)

  await browser.openOrReuseTab(url, { wait: true, timeout: 20000 })
  const ready = await page.waitForFunction(
    () => Boolean(document.querySelector('h1')),
    { timeout: 15000 },
  )
  if (!ready) throw new Error('目标标题没有出现')

  const result = {
    title: await page.title(),
    heading: await page.getByRole('heading').first().innerText(),
    learnedSite: learned.exists ? learned.siteId : null,
  }
  const completion = await taskSpaces.complete(task.id, { keep: false })
  if (!completion.done) throw new Error(`任务空间未完成 ${JSON.stringify(completion)}`)
  completed = true
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (task && !completed && !preserveTask) {
    await taskSpaces.complete(task.id, { keep: false }).catch(() => {})
  }
}
'@ | ego-browser nodejs
```

POSIX shell 使用 heredoc。

```bash
ego-browser nodejs <<'EOF'
let task
let completed = false
let preserveTask = false
try {
  task = await taskSpaces.useOrCreate('inspect example')
  const url = 'https://example.com'
  await browser.openOrReuseTab(url, { wait: true, timeout: 20000 })

  const heading = await page.getByRole('heading').first().innerText()
  if (!heading) throw new Error('目标标题没有出现')

  const completion = await taskSpaces.complete(task.id, { keep: false })
  if (!completion.done) throw new Error(`任务空间未完成 ${JSON.stringify(completion)}`)
  completed = true
  console.log(JSON.stringify({ heading, url: await page.url() }, null, 2))
} finally {
  if (task && !completed && !preserveTask) {
    await taskSpaces.complete(task.id, { keep: false }).catch(() => {})
  }
}
EOF
```

一次调用应当包含所有可预测步骤。只有人工接管、必须在脚本外查看截图，或者当前命令无法继续恢复时才拆成下一次调用。调用 `taskSpaces.handOff(task.id)` 并确认 `done` 后，先把 `preserveTask` 设为 `true`，随后结束脚本，防止 `finally` 关闭交给用户的任务空间。

## API 映射

| 旧 web-access 能力 | Ego 调用 |
| --- | --- |
| 创建或复用标签页 | `taskSpaces.useOrCreate`、`browser.openOrReuseTab` |
| 标签页列表与切换 | `browser.listTabs`、`browser.switchTab` |
| 页面信息与导航 | `page.info`、`page.url`、`page.goto`、`page.goBack` |
| JavaScript 执行 | `page.evaluate`、Locator `evaluateAll` |
| 点击和表单 | 语义 Locator `click`、`fill`、`check`、`selectOption` |
| 滚动与键盘鼠标 | Locator、`page.keyboard`、`page.mouse` |
| 文件上传 | 文件 Locator `setInputFiles` |
| 截图 | `page.screenshot`、Locator `screenshot` |
| 浏览器同源请求 | `fetch.browser` |
| 浏览器外 HTTP 请求 | `fetch.server` |
| 底层 CDP | `cdp` |
| 登录或验证码接管 | `taskSpaces.handOff` |
| 站点经验 | `site.learnContext`、`site.runTool`、`site.runBrowserTool` |
| 结束并清理 | `taskSpaces.complete(..., { keep })` |

## 交互路径

### 语义页面

先用 `page.snapshot()` 了解结构，再用角色、标签、占位文字、测试 id 或稳定 CSS 属性定位。`@N` 只在当前脚本最新一次 snapshot 后有效。

### 结构化列表

先提取候选，再选择。

```js
const cards = page.locator('article')
const items = await cards.evaluateAll((nodes) => nodes.map((node) => ({
  title: node.querySelector('h2')?.textContent?.trim() || '',
  href: node.querySelector('a')?.href || '',
})))
const chosen = items.findIndex((item) => item.title && item.href)
if (chosen < 0) throw new Error(`没有可用候选 ${JSON.stringify(items)}`)
await cards.nth(chosen).getByRole('link').first().click()
```

### 请求触发

等待必须先于动作。

```js
const responsePromise = page.waitForResponse(
  (response) => response.url().includes('/api/results') && response.ok(),
  { timeout: 15000 },
)
await page.getByRole('button', { name: /搜索|search/i }).click()
const response = await responsePromise
if (!response) throw new Error('目标请求没有成功返回')
```

### 视觉界面

画布、地图、虚拟化编辑器和无障碍树不足的界面可用截图与坐标。先截图确认视口有效，再做最小动作并通过第二张截图或导出结果验证。`page.info()` 返回零宽或零高时停止坐标操作。

## 关键差异

- Ego 的 `page.url()` 是异步方法，必须写成 `await page.url()`。
- `page.waitForURL` 的函数参数收到 `URL` 对象，应读取 `url.href`、`url.pathname` 或 `url.searchParams`。
- 页面、Locator、导航与浏览器 helper 的超时使用毫秒。`fetch.server`、`fetch.browser` 和 `taskSpaces.waitForAgentControl` 的超时使用秒。
- `fetch.browser` 在当前页面源内发起请求。调用前必须选择任务空间并打开目标源页面，跨源限制与页面自身一致。
- Locator 默认严格匹配并自动等待。出现多个匹配时先检查数量与文本，再缩小范围。
- `targetId` 是短期句柄。需要跨命令继续时重新调用 `browser.listTabs()` 并核对 URL。
- 弹窗信息可由 `page.info()` 发现。需要时调用 `cdp('Page.handleJavaScriptDialog', { accept: true })`。
- 任务空间的控制权错误属于策略边界。按主 Skill 的人工接管规则处理。
