---
name: web-access-ego
license: MIT
description: 本机联网任务的统一路由。通过搜索、静态抓取与 EgoLite 完成网页核实、动态页面读取、登录态操作、表单、上传和截图；学术检索与论文下载会转交 scansci-pdf。只要任务需要联网、网页或当前信息就触发，不要求用户点名 Ego。
metadata:
  version: "0.2.0"
  upstream: "eze-is/web-access@2.5.4"
  upstream_commit: "33eef84a55b1919396a80e7a55650a07bb83f590"
  upstream_url: "https://github.com/eze-is/web-access"
  ego_browser_compat: "1.2.x"
---

# web-access for Ego

这个 Skill 保留 `web-access` 的联网路由、页面验证、来源优先级和站点经验规则。真实浏览器部分直接调用 Ego，不启动 Chrome 或 Edge 远程调试端口，也不运行本地 CDP 代理。

本机所有需要联网、网页核实、当前信息或浏览器交互的任务都从本 Skill 进入。由本 Skill 决定静态路径、ScanSci 学术路径或 EgoLite 浏览器路径。浏览器接口与控制规则以当前安装的 `ego-browser` Skill 为准。不要执行 `web-access` 的远程调试检查和 CDP Proxy 脚本。

## 统一触发与分流

拿到任务后先判断交付物，再选择通道。

| 用户目标 | 主通道 | 何时进入 EgoLite |
| --- | --- | --- |
| 查询当前事实、官网信息、新闻、产品文档 | 本 Skill 的搜索与静态抓取 | 静态内容缺失、动态渲染或需要登录态时 |
| 搜索论文、解析 DOI/arXiv、导出引文 | `scansci-pdf` | ScanSci 判断出版社或机构页面需要浏览器时 |
| 下载单篇或批量论文 | `scansci-pdf` | WebVPN、CARSI、出版社 SSO、验证码或 Cookie 同步时 |
| 阅读已经下载的论文 | `pdf` Skill | PDF 只能在登录页面内查看且尚未落盘时 |
| 基于联网材料或论文写中文稿 | 先完成证据获取，再交给 `human-writing` | 写作阶段不额外浏览，缺证据时退回本 Skill补齐 |

普通网页任务不要调用 ScanSci。论文任务也不要让通用网页浏览代替 DOI 验证、队列、下载状态和 PDF 文件校验。

## 与 ScanSci PDF 的交接协议

1. 论文意图一旦成立，先加载 `scansci-pdf`，调用 `scansci_pdf_config()` 读取当前来源开关。
2. 发现阶段由 ScanSci Find、OpenAlex、引文追踪和 DOI 校验形成候选。官网或研究机构网页等补充证据可由本 Skill核实。
3. 下载阶段由 ScanSci 按缓存、开放获取、Elsevier API、机构授权、显式开启来源的顺序运行。`web-access-ego` 不自行下载论文并伪装成 ScanSci 成功。
4. 需要浏览器时固定使用 EgoLite 的共享 Task Space `paper download`。EgoLite 离线由 ScanSci 桥接唤醒，不启动 Chrome、Edge、Patchright 或 CloakBrowser。
5. 登录完成只代表会话可能可用。必须回到 ScanSci 重试下载，并验证 PDF 文件头、DOI、题名、页数、文件大小和哈希，随后才记录成功。
6. ECNU 使用 WebVPN、CARSI/Shibboleth 或 VPN。EZproxy 状态为 `not_applicable` 时直接转 WebVPN，不尝试登录。

## 证据与写作交接

写作前整理一份最小证据包，包含来源标题、规范 URL 或 DOI、发布日期或论文年份、已核实事实、直接证据位置和仍不确定的部分。论文全文还要保留本地 PDF 路径与验证结果。

中文成稿交给 `human-writing` 时，只传递已经核实的材料和明确标注的推断。需要补证据时退回本 Skill 或 ScanSci，不在写作阶段补造数据、引语、论文结论和页面状态。

## 能力边界

- 删除 `check-deps.mjs`、`browser-discovery.mjs`、`cdp-proxy.mjs` 与浏览器选择配置。第一次真实操作直接调用 `ego-browser nodejs`。
- 不读取或控制 Chrome、Edge 的现有标签页、历史记录、书签和内部设置页。Ego 自动化只操作自己的任务空间与 Chromium 页面。
- `chrome://`、`edge://` 等浏览器内部页面不属于可操作网页。不要反复尝试绕过这个限制。
- 搜索 API、静态网页抓取、`curl` 和 Jina 继续作为浏览器外的联网路径。Ego 负责动态页面、登录态、页面交互与浏览器同源请求。

## 先定义完成条件

开始前先明确用户需要的事实、页面状态、文件或外部操作结果。后续每一步都用可观察结果对照这个条件。搜索结果、导航成功、HTTP 200、页面标题和 `document.readyState` 都不能单独证明任务已经完成。

遇到失败时先判断当前路径还能否提供新证据。重复请求没有带来变化，页面持续缺少目标内容，或者接口持续返回同一错误时，改用另一条可行路径。目标可能不存在时应当如实报告，禁止通过增加搜索次数制造确定感。

## 选择联网路径

| 目标 | 首选路径 |
| --- | --- |
| 发现关键词、候选页面和一手来源 | Agent 提供的搜索 API |
| 已知 URL，正文可由静态层读取 | Web fetch 或 Jina |
| 需要原始 HTML、JSON-LD 或接口正文 | `curl`、普通 HTTP 客户端或 Ego `fetch.server` |
| 需要响应头或非成功状态的完整响应 | `curl` 或能返回响应对象的普通 HTTP 客户端 |
| 页面需要浏览器同源环境 | Ego `fetch.browser` |
| 动态渲染、登录态、点击、输入、滚动、上传、截图 | Ego `page` 与 Locator |
| 现有 facade 没有覆盖的浏览器能力 | Ego 原生 `cdp`，仅作最后手段 |

搜索与聚合页面用于发现来源。重要结论回到官网、正式文件、原始论文、公司公告、产品源码或其它一手材料核实。静态路径已经取得完整结果时不要额外打开浏览器。静态路径被登录墙、动态渲染、反爬或交互流程挡住时，直接切到 Ego。

Jina 只用于公开内容。登录页面、内网页面、签名 URL、token、cookie、个人数据和组织内部资料都不能发送给 Jina。它适合正文型网页、文档和 PDF 的预处理，可能丢失页面结构、交互状态与数据面板内容，关键事实仍需回到原页面核对。

## 使用 Ego 浏览器

需要真实浏览器时，先加载当前安装的 `ego-browser` Skill，再读取 [references/ego-runtime.md](references/ego-runtime.md)。配套 Skill 负责准确接口、控制权与更新规则，这份参考只说明联网路由需要的差异和旧 CDP Proxy 映射。

浏览器任务遵守这些要求。

1. 用目标导向的短名称调用 `taskSpaces.useOrCreate(...)`。
2. URL 未知时先按用户文字匹配本 Skill 的站点别名。URL 已知后读取本 Skill 的域名经验，并调用 `site.learnContext(url)` 读取 Ego 原有经验。
3. 用 `browser.openOrReuseTab(url, { wait: true, timeout: 20000 })` 打开页面。确有证据需要更长时间时再调整超时。
4. 先观察页面，再选择语义 Locator、视觉输入或 `page.evaluate`。
5. 在同一个脚本中完成可预测的操作、等待、提取、验证和清理。
6. 成功后调用 `taskSpaces.complete(task.id, { keep: false })`，并检查 `done`。

默认不保留任务空间。用户要求继续查看页面、需要人工操作，或者结果只能留在页面中时才用 `keep: true`。

## 页面就绪与结果验证

导航完成以后，用与目标内容直接相关的条件检查页面。默认在 15 秒内观察 URL、标题、主要 DOM 与已知中间状态。页面仍在跳转、加载、验证或登录流程中时继续等待，并在内容变化后重新判断。

- 用 `page.waitForURL`、`page.waitForResponse`、`page.waitForFunction`、Locator `waitFor` 等事件或状态条件等待。
- 在触发请求或导航前先注册对应的等待。
- 所有改变页面状态的操作都要读取结果。点击成功、输入成功和请求成功只说明动作发生过。
- 等待方法超时会返回假值时，立即检查并处理。不要带着未验证的假设继续。
- 固定延时只能用于不超过两秒的短暂视觉稳定，不能作为导航、筛选、提交或数据变化的主要等待方式。

普通 DOM 页面优先使用 `getByRole`、`getByLabel`、`getByText`、`getByPlaceholder` 与稳定属性。列表先提取结构化候选，再决定要点击哪一项。画布、地图、虚拟化编辑器等语义信息不足的界面可改用截图和鼠标键盘。`page.evaluate` 适合读取页面状态或完成 facade 未覆盖的 DOM 操作。原生 `cdp` 只处理最后一层缺口。

从页面交互中取得的链接应保留完整 `href`，包括站点正常导航所需的查询参数。不要手工裁剪后重新构造。含会话 token、签名或个人数据的完整链接只用于当前任务导航，不能写入日志、站点经验或最终回复。公开来源可以另取安全的规范链接用于引用。

## 登录、验证码与人工接管

Ego 任务空间继承用户的登录态。先尝试获取目标内容，只有确认缺少登录或人工验证会阻止完成时才交接。

需要人工操作时，在当前脚本完成所有安全准备，调用 `taskSpaces.handOff(task.id)` 并检查 `done`。使用异常清理模板时，交接成功后把 `preserveTask` 设为 `true`。告诉用户具体要完成哪一步，然后停止。用户明确确认后，用同一个名称或任务空间 id 调用 `useOrCreate` 继续。

用户控制、任务空间未分配或任务空间失活的错误，在 `useOrCreate` 自带恢复仍失败后属于硬停止。不要循环接管或创建替代空间。

在登录账号上执行可能触发站点风控的自动化操作前，向用户显示下面的提醒并停止当前回合。

> 自动化操作可能触发站点风控并导致账号受限。继续操作代表接受这项风险。

收到用户明确确认后才能继续高风险自动化。这段确认只接受账号风控，不提供新的操作授权。发布、发送、购买、删除、账号修改和其它会改变外部状态的动作，必须已经包含在用户请求中。授权范围不清楚时停在提交前并询问用户。

## 上传、下载、截图与媒体

- 上传使用文件 Locator 的 `setInputFiles(...)`。文件路径必须来自用户授权范围。
- 下载要等待下载事件，并验证文件确实产生。不要只依据点击结果。
- 截图使用 `page.screenshot(...)` 或 Locator `screenshot(...)`。需要视觉判断时再打开本地图片。
- 图片承载核心信息时，先从 DOM 提取原始媒体 URL。公开资源可定向下载，需要登录态的资源留在 Ego 中读取。
- 视频可通过 `page.evaluate` 检查 `<video>` 状态并定位时间点，再用截图采样。采样结论应说明覆盖范围。

## 站点经验

本 Skill 有自己的可写经验目录 `references/site-patterns/`。Ego 自带的 `site` facade 提供配套 `ego-browser` Skill 中的原有经验，本 Skill 只读取它，不修改它。匹配方式、工具调用与维护规则见 [references/site-learnings.md](references/site-learnings.md)。

经验只用于加速判断。选择器、URL 模式、登录要求和风控行为会变化，实际页面结果始终优先。任务成功后，只有发现可复用且经过验证的新事实时才更新本 Skill 的经验。写清发现日期，不记录猜测、临时 `@N` 引用、完整签名 URL、会话 token 或个人数据。

## 信息核实

核实任务以一手来源为终点。多个二手页面重复同一说法不能形成独立证明。

| 信息类型 | 优先来源 |
| --- | --- |
| 政策与法规 | 发布机构官网与正式文本 |
| 企业信息 | 公司公告、监管披露、官方产品文档 |
| 学术结论 | 原始论文、数据集与研究机构页面 |
| 工具能力 | 官方文档、源码与实际运行结果 |

找不到一手材料时可以使用可信的原创报道，并明确说明来源层级与可能的转述误差。无法确认的内容直接标注不确定。不要补写数据、引语或页面状态。

## 并行调研

多个目标互不依赖且每个目标都有足够工作量时，可以分给不同 Agent。每个 Agent 使用独立任务空间，完成后自行清理。子任务描述写清目标与交付结果，不预先限定它必须使用搜索、静态抓取或 Ego。

简单单页读取、少量搜索和存在前后依赖的任务保持串行。

## 结束检查

- 完成条件已经由页面内容、接口结果、文件或外部状态证明。
- 关键事实来自可追溯来源，推断与事实已经区分。
- 自己创建的任务空间与临时标签页已经完成或明确交给用户。
- 没有把登录态、token、个人数据或内部页面内容写入站点经验。

<!-- BEGIN GENERATED AUTOMATION CONTRACT -->
## Installed EgoLite interface contract

Read [the generated interface reference](references/automation-api.md) for exact MCP parameters, defaults and SDK method availability.

- The full ego_* MCP and SDK operate on the selected task's tab. The ego_desktop_* MCP operates on the visible desktop page. A tool appearing in tools/list does not grant control or prove that the connected backend supports every operation.

- When scoped-refs-v1 is negotiated, @refs identify a runtime, task, page, frame and document. Partial snapshots merge references; complete-page snapshots replace that page's reference set. Navigation, frame removal, reconnect or a page change can invalidate refs. Never reinterpret a public ref as a native backendNodeId. Without negotiation, refs use the legacy native-v0 behavior.

- On the desktop scoped backend, use snapshot @refs for same-process, cross-process and nested iframe elements. Ordinary CSS/role locators remain rooted in the main frame. Child-frame stable locators are omitted. browser.iframeTarget() is not supported for desktop iframe discovery because Target.getTargets exposes top-level pages only.

- Scoped drag supports exactly two refs in the same page, frame, document and native session. Cross-frame drag, mixed ref/coordinate endpoints and multi-point paths containing scoped refs are rejected.

- The MCP screenshot tools capture a page, not a target ref. SDK scoped locator screenshots support the root native session and same-process frames sharing it. OOPIF element screenshots are unavailable; use a page screenshot.

- Scoped network waits observe the live sessions of the selected page at wait start. They do not promise to capture initial requests from frames created later. Response bodies use the original source session. Register the wait before triggering the request.

- Task spaces have separate tabs and control leases. Login state belongs to the selected browser Profile; spaces using that Profile can share its login state. This does not import another browser's cookies. Read-only observation grants no write access. After handoff, request and obtain control through the existing policy before writing.

- EGO_REFERENCE_STALE requires a fresh snapshot. EGO_FRAME_UNAVAILABLE requires re-observation after the frame becomes ready. EGO_ACTION_RESULT_UNKNOWN means input may have reached the page; inspect the result and do not automatically replay it. Raw CDP remains authorized but does not gain scoped-ref identity guarantees.

- Keep composed SDK workflows for deterministic work. Use ego_run with explicit steps, mode repair and independent success checks when locator recovery is needed. targetHint enables local exact-label recovery, then at most one Jev target-selection decision if its non-ref locator is absent before dispatch. Intact steps use no Jev. Repair never retries an action error or invents steps; direct disables model fallback, auto retains goal-only exploration. Semantic decisions need the selected Profile's TypeSafe key and cloud consent. Use ego_extract for main-frame rows and pagination. If its connected schema supports relevance, use named extracted fields for bounded semantic screening of noisy lists; unknown rows survive. Check both complete and relevance.complete, plus unknownRows; relevance is not factual verification. Do not use a second writer during a run. Cancel with ego_automation_cancel. A done status requires verified evidence; inspect handoffs, partial extraction and unknown outcomes. Supply authorizedActions only for explicitly authorized consequential actions. These tools do not add backend capabilities.

<!-- END GENERATED AUTOMATION CONTRACT -->
