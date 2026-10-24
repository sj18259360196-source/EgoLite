export function createBookmarkLibrary({ invoke, refresh, open, editExcerpt, confirm, toast, manage, browse, currentPage }) {
  let data = { items: [], folders: [] };
  let view = "all";
  let selected = new Set();
  let busy = false;
  let savingPage = false;
  let visibleEntries = [];
  const collapsed = new Set();
  const panelExpanded = new Set(["bar", "other"]);
  let panelPinned = localStorage.getItem("ego-favorites-pinned") === "1";
  let barVisible = localStorage.getItem("ego-favorites-bar") !== "0";
  let popupAnchor = null;
  let lastFocusedRow = "";
  const $ = selector => document.querySelector(selector);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = name => {
    const node = el("i");
    node.dataset.lucide = name;
    return node;
  };
  const button = (name, label, action, text = false) => {
    const node = el("button", text ? "bm-command" : "icon-button");
    node.type = "button";
    node.title = label;
    node.setAttribute("aria-label", label);
    node.append(icon(name));
    if (text) node.append(el("span", "", label));
    node.addEventListener("click", () => run(action));
    return node;
  };
  const icons = () => window.lucide?.createIcons();
  function errorText(error) {
    const message = error.message || String(error);
    for (const [source, translation] of [
      ["A folder cannot contain itself", "不能将文件夹移入自身或子文件夹"],
      ["A folder with this name already exists", "此目录中已有同名文件夹"],
      ["Folder not found", "文件夹已不存在，请重新选择"],
      ["Unsupported bookmark URL", "仅支持 HTTP、HTTPS 或本地文件网址"],
      ["Invalid URL", "请输入完整的网址"],
      ["Drop target no longer exists", "目标位置已变化，请重试"],
    ]) if (message.includes(source)) return translation;
    return message;
  }
  function entryIcon(entry) {
    if (!isFolder(entry) && entry.faviconUrl && /^(https?:|data:image\/)/i.test(entry.faviconUrl)) {
      const image = el("img", "bm-favicon");
      image.src = entry.faviconUrl;
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => { image.replaceWith(icon("bookmark")); icons(); }, { once: true });
      return image;
    }
    return icon(isFolder(entry) ? "folder" : entry.kind === "bookmark" ? "bookmark" : "file-text");
  }
  async function run(action) {
    try { await action(); } catch (error) { toast(errorText(error), true); }
  }
  async function mutate(method, payload) {
    if (busy) return false;
    busy = true;
    try {
      const result = await invoke(method, payload);
      if (result === false) throw new Error("保存失败，请重试");
      data = await invoke("collection.library");
      await refresh();
      render();
      return true;
    } finally { busy = false; }
  }
  const activeFolders = () => data.folders.filter(folder => !folder.deletedAt);
  const folderOf = id => data.folders.find(folder => folder.id === id);
  function path(id) {
    const names = [];
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const folder = folderOf(id);
      if (!folder) break;
      names.unshift(folder.name);
      id = folder.parentId;
    }
    return names.join(" / ");
  }
  const sorted = entries => entries.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  const children = id => sorted([
    ...activeFolders().filter(folder => folder.parentId === id),
    ...data.items.filter(item => !item.deletedAt && item.folderId === id),
  ]);
  const isFolder = entry => "parentId" in entry;
  const title = entry => isFolder(entry) ? entry.name : entry.pageTitle || entry.text || entry.sourceUrl;
  function navigate(id) { view = id; selected.clear(); render(); }
  function manageFolder(id = "all") {
    closePanel(false);
    popup.hidden = true;
    search.value = "";
    tags.value = "";
    navigate(id);
    manage();
  }

  const host = $("#library-view");
  host.classList.add("bm-library");
  host.querySelector(".library-header h1").textContent = "收藏夹";
  host.querySelector(".library-header .eyebrow").hidden = true;
  const legacyToolbar = host.querySelector(".library-toolbar");
  const fileActions = host.querySelector(".library-file-actions");
  const oldBatch = host.querySelector(".collection-batchbar");
  legacyToolbar.hidden = true;
  oldBatch.hidden = true;
  $("#collection-list").hidden = true;
  const layout = el("div", "bm-layout");
  const tree = el("nav", "bm-tree");
  tree.setAttribute("aria-label", "收藏目录");
  const main = el("section", "bm-main");
  const toolbar = el("div", "bm-toolbar");
  const search = el("input", "bm-search");
  search.type = "search";
  search.placeholder = "搜索标题、网址或内容";
  search.setAttribute("aria-label", search.placeholder);
  search.addEventListener("input", () => { selected.clear(); renderRows(); });
  const sort = el("select", "compact-select");
  sort.setAttribute("aria-label", "排序");
  for (const [value, label] of [["manual", "自定义顺序"], ["title", "按名称"], ["newest", "最近保存"]]) sort.add(new Option(label, value));
  sort.addEventListener("change", renderRows);
  const tags = el("select", "compact-select");
  tags.setAttribute("aria-label", "标签");
  tags.addEventListener("change", () => { selected.clear(); renderRows(); });
  toolbar.append(search, tags, sort, button("folder-plus", "新建文件夹", () => folderDialog()),
    button("plus", "添加书签", () => bookmarkDialog()), fileActions);
  fileActions.hidden = true;
  const managerMore = button("ellipsis", "管理选项", () => showMenu(managerMore, [
    ["upload", "导入收藏", () => $("#import-collections").click()],
    ["download", "导出 JSON", () => exportAs("json")],
    ["download", "导出书签 HTML", () => exportAs("bookmarks-html")],
    ["download", "导出 Markdown", () => exportAs("markdown")],
    ["copy-check", "整理重复项", () => $("#find-collection-duplicates").click()],
  ]));
  managerMore.classList.add("bm-menu-trigger");
  toolbar.append(managerMore);
  function exportAs(format) {
    $("#collection-export-format").value = format;
    $("#export-collections").click();
  }
  const heading = el("div", "bm-heading");
  const breadcrumb = el("div", "bm-breadcrumb");
  const batch = el("div", "bm-batch");
  heading.append(breadcrumb, batch);
  const rows = el("div", "bm-rows");
  rows.setAttribute("role", "list");
  rows.setAttribute("aria-label", "收藏列表");
  main.append(toolbar, heading, rows);
  layout.append(tree, main);
  host.append(layout);
  const popup = el("div", "bm-popup");
  popup.hidden = true;
  popup.setAttribute("role", "menu");
  document.body.append(popup);
  document.addEventListener("pointerdown", event => {
    if (!popup.contains(event.target) && !event.target.closest(".bm-menu-trigger")) popup.hidden = true;
    if (!panel.hidden && !panel.classList.contains("is-pinned") && !panel.contains(event.target) &&
      !event.target.closest("#browser-favorites, .bm-popup, .bm-dialog")) closePanel(false);
    const quick = document.querySelector(".bm-quick-save[open]");
    if (quick && !quick.contains(event.target) && !event.target.closest("#save-page")) quick.close();
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (!popup.hidden) { popup.hidden = true; popupAnchor?.focus(); event.stopPropagation(); }
    else if (document.querySelector(".bm-quick-save[open]")) document.querySelector(".bm-quick-save[open]").close();
    else if (!panel.hidden) closePanel();
  });
  document.addEventListener("focusin", event => {
    if (event.target.tagName !== "WEBVIEW") return;
    popup.hidden = true;
    if (!panel.hidden && !panel.classList.contains("is-pinned")) closePanel(false);
    document.querySelector(".bm-quick-save[open]")?.close();
  });
  window.addEventListener("resize", () => { popup.hidden = true; renderBar(); positionPanel(); positionQuickSave(); });

  const surface = $(".browser-surface");
  const panel = el("aside", "bm-panel");
  panel.id = "favorites-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "收藏夹");
  const panelHead = el("div", "bm-panel-head");
  const panelTitle = el("strong", "", "收藏夹");
  const panelSearchToggle = button("search", "搜索收藏", () => {
    panelSearchBox.hidden = !panelSearchBox.hidden;
    panelSearchToggle.setAttribute("aria-expanded", String(!panelSearchBox.hidden));
    if (!panelSearchBox.hidden) panelSearch.focus();
    else { panelSearch.value = ""; renderPanel(); }
  });
  panelSearchToggle.setAttribute("aria-expanded", "false");
  const panelPin = button("pin", "固定收藏夹", () => {
    panelPinned = !panelPinned;
    localStorage.setItem("ego-favorites-pinned", panelPinned ? "1" : "0");
    positionPanel();
  });
  const panelMore = button("ellipsis", "收藏夹选项", () => {
    showMenu(panelMore, [
      ["bookmark-plus", "收藏当前页", () => savePage(currentPage(), true)],
      ["folder-plus", "新建文件夹", () => folderDialog(undefined, "other")],
      ["upload", "导入收藏", () => $("#import-collections").click()],
      ["download", "导出收藏", () => { manageFolder(); $("#export-collections").click(); }],
      [barVisible ? "check" : "minus", "显示收藏栏", () => toggleBar()],
    ]);
    const toggle = [...popup.querySelectorAll("button")].find(node => node.textContent === "显示收藏栏");
    toggle?.setAttribute("role", "menuitemcheckbox");
    toggle?.setAttribute("aria-checked", String(barVisible));
  });
  panelMore.classList.add("bm-menu-trigger");
  panelHead.append(panelTitle, panelSearchToggle, panelPin, panelMore, button("x", "关闭收藏夹", () => closePanel()));
  const panelSearchBox = el("div", "bm-panel-search");
  panelSearchBox.hidden = true;
  const panelSearch = input("", "search");
  panelSearch.required = false;
  panelSearch.placeholder = "搜索收藏夹";
  panelSearch.setAttribute("aria-label", "搜索收藏夹");
  panelSearch.addEventListener("input", renderPanel);
  panelSearchBox.append(icon("search"), panelSearch);
  const panelList = el("div", "bm-panel-list");
  panelList.setAttribute("role", "tree");
  panelList.setAttribute("aria-label", "网页收藏");
  const panelFooter = button("square-arrow-out-up-right", "管理收藏夹", () => manageFolder(), true);
  panelFooter.classList.add("bm-panel-footer");
  panel.append(panelHead, panelSearchBox, panelList, panelFooter);
  surface.append(panel);
  // Resize and docking changes affect both the webview and the flyout anchor.
  new ResizeObserver(() => { positionPanel(); positionQuickSave(); }).observe(surface);
  new MutationObserver(() => positionPanel()).observe(surface, { attributes: true, attributeFilter: ["class"] });
  applyBarVisibility();

  function positionPanel() {
    const active = !panel.hidden && $("#start-view").classList.contains("active");
    const width = surface.clientWidth;
    const docked = active && panelPinned && width >= 680 && !surface.classList.contains("devtools-open");
    if (surface.classList.contains("bm-panel-pinned") !== docked) surface.classList.toggle("bm-panel-pinned", docked);
    panel.classList.toggle("is-pinned", docked);
    panelPin.setAttribute("aria-pressed", String(panelPinned));
    panelPin.title = panelPinned ? "取消固定收藏夹" : "固定收藏夹";
    panelPin.setAttribute("aria-label", panelPin.title);
    if (!active) return;
    const frame = surface.getBoundingClientRect();
    const toolbarBottom = $(".browser-toolbar").getBoundingClientRect().bottom;
    const top = (docked ? (barVisible ? $("#favorites-bar").getBoundingClientRect().bottom : toolbarBottom) : toolbarBottom) - frame.top;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(80, frame.height - top - (docked ? 0 : 8))}px`;
  }
  function closePanel(restoreFocus = true) {
    panel.hidden = true;
    surface.classList.remove("bm-panel-pinned");
    $("#browser-favorites").setAttribute("aria-expanded", "false");
    if (restoreFocus) $("#browser-favorites").focus();
  }
  function togglePanel() {
    if (!panel.hidden) { closePanel(); return; }
    browse();
    popup.hidden = true;
    for (const node of document.querySelectorAll("#downloads-panel, #history-panel, #extensions-panel, #credentials-panel, #browser-more-menu")) node.hidden = true;
    panel.hidden = false;
    $("#browser-favorites").setAttribute("aria-expanded", "true");
    renderPanel();
    positionPanel();
    panelList.querySelector('[role="treeitem"]')?.focus();
  }
  function applyBarVisibility() {
    $("#favorites-bar").hidden = !barVisible;
    surface.classList.toggle("bm-bar-hidden", !barVisible);
  }
  function toggleBar() {
    barVisible = !barVisible;
    localStorage.setItem("ego-favorites-bar", barVisible ? "1" : "0");
    applyBarVisibility();
    renderBar();
    positionPanel();
  }
  function renderPanel() {
    if (panel.hidden) return;
    const scroll = panelList.scrollTop;
    const focused = panelList.contains(document.activeElement) ? document.activeElement.closest("[data-entry-id]")?.dataset.entryId : null;
    panelList.replaceChildren();
    const needle = panelSearch.value.trim().toLocaleLowerCase();
    const bookmarks = data.items.filter(item => !item.deletedAt && item.kind === "bookmark");
    function entryRow(entry, depth) {
      const folder = isFolder(entry);
      const line = el("div", "bm-panel-row");
      line.style.setProperty("--bm-depth", Math.min(depth, 8));
      const control = el("button", "bm-panel-entry");
      control.type = "button";
      control.dataset.entryId = entry.id;
      control.setAttribute("role", "treeitem");
      control.setAttribute("aria-level", String(depth + 1));
      control.title = folder ? path(entry.id) : `${title(entry)}\n${entry.sourceUrl}`;
      if (folder) {
        control.setAttribute("aria-expanded", String(panelExpanded.has(entry.id)));
        control.append(icon(panelExpanded.has(entry.id) ? "chevron-down" : "chevron-right"));
      } else control.append(el("span", "bm-tree-spacer"));
      control.append(entryIcon(entry), el("span", "bm-panel-label", title(entry)));
      control.addEventListener("click", () => run(async () => {
        if (folder) {
          if (panelExpanded.has(entry.id)) panelExpanded.delete(entry.id);
          else panelExpanded.add(entry.id);
          renderPanel();
          panelList.querySelector(`[data-entry-id="${entry.id}"]`)?.focus();
        } else {
          if (!panel.classList.contains("is-pinned")) closePanel(false);
          await open(entry);
        }
      }));
      const more = button("ellipsis", `${title(entry)}的更多操作`, () => showMenu(more, actions(entry)));
      more.classList.add("bm-menu-trigger", "bm-panel-row-more");
      more.tabIndex = -1;
      line.append(control, more);
      line.addEventListener("contextmenu", event => { event.preventDefault(); showMenu(control, actions(entry)); });
      drag(line, entry, folder ? entry.id : undefined);
      panelList.append(line);
      if (needle && !folder) line.append(el("span", "bm-panel-location", path(entry.folderId)));
    }
    function branch(parentId, depth) {
      for (const entry of children(parentId).filter(entry => isFolder(entry) || entry.kind === "bookmark")) {
        entryRow(entry, depth);
        if (isFolder(entry) && panelExpanded.has(entry.id)) branch(entry.id, depth + 1);
      }
    }
    if (needle) {
      for (const item of bookmarks.filter(item => [title(item), item.sourceUrl, path(item.folderId)].join("\n").toLocaleLowerCase().includes(needle))) entryRow(item, 0);
    } else {
      for (const root of sorted(activeFolders().filter(folder => !folder.parentId))) {
        entryRow(root, 0);
        if (panelExpanded.has(root.id)) branch(root.id, 1);
      }
    }
    if (!panelList.children.length) panelList.append(el("p", "bm-empty", "没有匹配的收藏"));
    icons();
    panelList.scrollTop = scroll;
    if (focused) panelList.querySelector(`[data-entry-id="${focused}"]`)?.focus({ preventScroll: true });
  }
  panelList.addEventListener("keydown", event => {
    const controls = [...panelList.querySelectorAll('[role="treeitem"]')];
    const current = event.target.closest('[role="treeitem"]');
    if (!current) return;
    const index = controls.indexOf(current);
    const entry = [...data.folders, ...data.items].find(item => item.id === current.dataset.entryId);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      controls[event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 :
        Math.max(0, Math.min(controls.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (event.key === "ArrowRight" && isFolder(entry)) {
      event.preventDefault();
      if (!panelExpanded.has(entry.id)) current.click();
      else controls[index + 1]?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (isFolder(entry) && panelExpanded.has(entry.id)) current.click();
      else panelList.querySelector(`[data-entry-id="${isFolder(entry) ? entry.parentId : entry.folderId}"]`)?.focus();
    } else if (event.key === "F2") {
      event.preventDefault();
      void run(() => isFolder(entry) ? entry.parentId && folderDialog(entry) : bookmarkDialog(entry));
    } else if (event.key === "Delete" && (!isFolder(entry) || entry.parentId)) {
      event.preventDefault(); void run(() => trash([entry.id]));
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); showMenu(current, actions(entry));
    }
  });

  function selectFolder(value, exclude) {
    const select = el("select", "bm-folder-select");
    select.setAttribute("aria-label", "文件夹");
    for (const folder of activeFolders()) {
      let ancestor = folder;
      const seen = new Set();
      while (ancestor && ancestor.id !== exclude && !seen.has(ancestor.id)) {
        seen.add(ancestor.id);
        ancestor = folderOf(ancestor.parentId);
      }
      if (exclude && ancestor?.id === exclude) continue;
      select.add(new Option(path(folder.id), folder.id));
    }
    select.value = value || "other";
    return select;
  }
  function dialog(name, anchor) {
    for (const previous of document.querySelectorAll(".bm-quick-save[open]")) previous.close();
    popup.hidden = true;
    const node = el("dialog", "bm-dialog");
    if (anchor) node.classList.add("bm-quick-save");
    const form = el("form");
    const header = el("div", "bm-dialog-head");
    header.append(el("strong", "", name), button("x", "关闭", () => node.close()));
    form.append(header);
    node.append(form);
    node.addEventListener("close", () => node.remove());
    document.body.append(node);
    function field(label, control) {
      const wrapper = el("label", "bm-field");
      wrapper.append(el("span", "", label), control);
      form.append(wrapper);
      return control;
    }
    function submit(label, action) {
      const footer = el("div", "bm-dialog-actions");
      const error = el("p", "bm-error");
      error.setAttribute("role", "alert");
      const save = el("button", "primary-button", label);
      save.type = "submit";
      footer.append(button("x", "取消", () => node.close(), true), save);
      form.append(error, footer);
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (save.disabled) return;
        save.disabled = true;
        void Promise.resolve().then(action).then(ok => {
          if (ok !== false) node.close();
        }).catch(reason => { error.textContent = errorText(reason); })
          .finally(() => { save.disabled = false; });
      });
      if (anchor) { node.show(); positionQuickSave(); }
      else node.showModal();
      icons();
    }
    return { node, form, field, submit };
  }
  function input(value = "", type = "text") {
    const node = el("input");
    node.type = type;
    node.value = value;
    node.required = true;
    return node;
  }
  function positionQuickSave() {
    const quick = document.querySelector(".bm-quick-save[open]");
    if (!quick) return;
    const anchor = $("#save-page").getBoundingClientRect();
    quick.style.left = `${Math.max(8, Math.min(anchor.right - quick.offsetWidth, innerWidth - quick.offsetWidth - 8))}px`;
    quick.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, innerHeight - quick.offsetHeight - 8))}px`;
  }
  function folderDialog(folder, parentId) {
    const ui = dialog(folder ? "编辑文件夹" : "新建文件夹");
    const name = ui.field("名称", input(folder?.name));
    name.maxLength = 120;
    const parent = ui.field("所在文件夹", selectFolder(folder?.parentId || parentId || (folderOf(view) ? view : "other"), folder?.id));
    ui.submit("保存", () => mutate("collection.folderSave", { id: folder?.id, name: name.value, parentId: parent.value }));
  }
  function bookmarkDialog(item, saved = false, quick = false) {
    const ui = dialog(item?.id ? saved ? "已添加收藏" : "编辑收藏" : "添加书签", quick ? $("#save-page") : null);
    const name = ui.field("名称", input(item ? title(item) : ""));
    name.maxLength = 2000;
    const folder = ui.field("文件夹", selectFolder(item?.folderId || (folderOf(view) ? view : localStorage.getItem("ego-bookmark-folder"))));
    const createFolder = button("folder-plus", "新建文件夹", () => {
      newFolderBox.hidden = !newFolderBox.hidden;
      if (!newFolderBox.hidden) newFolderName.focus();
      positionQuickSave();
    });
    const folderLine = el("div", "bm-folder-line");
    folder.parentElement.append(folderLine);
    folderLine.append(folder, createFolder);
    const newFolderBox = el("div", "bm-inline-folder");
    newFolderBox.hidden = true;
    const newFolderName = input("");
    newFolderName.required = false;
    newFolderName.placeholder = "新文件夹名称";
    newFolderName.setAttribute("aria-label", "新文件夹名称");
    newFolderName.maxLength = 120;
    const folderError = el("span", "bm-error");
    folderError.setAttribute("role", "alert");
    newFolderBox.append(newFolderName, button("check", "创建文件夹", async () => {
      if (busy || !newFolderName.value.trim()) { newFolderName.focus(); return; }
      busy = true;
      try {
        const created = await invoke("collection.folderSave", { name: newFolderName.value.trim(), parentId: folder.value });
        data = await invoke("collection.library");
        await refresh();
        const updated = selectFolder(created.id);
        folder.replaceChildren(...updated.children);
        folder.value = created.id;
        newFolderBox.hidden = true;
        newFolderName.value = "";
        folderError.textContent = "";
        positionQuickSave();
      } catch (error) { folderError.textContent = errorText(error); }
      finally { busy = false; }
    }), folderError);
    ui.form.append(newFolderBox);
    const details = el("details", "bm-save-details");
    details.open = !quick;
    details.append(el("summary", "", "更多选项"));
    ui.form.append(details);
    details.addEventListener("toggle", positionQuickSave);
    const url = ui.field("网址", input(item?.sourceUrl || "", "url"));
    details.append(url.parentElement);
    const tagInput = input((item?.tags || []).join(", "));
    tagInput.required = false;
    ui.field("标签", tagInput);
    details.append(tagInput.parentElement);
    const readTags = () => tagInput.value.split(/[,，;；\n]/).map(value => value.trim()).filter(Boolean);
    if (!folder.value) folder.value = "other";
    if (item?.id) {
      const commands = el("div", "bm-dialog-actions");
      commands.append(button("copy", "另存一份", async () => {
        if (!ui.form.reportValidity()) return;
        if (await mutate("collection.bookmark", { title: name.value, url: url.value, folderId: folder.value, tags: readTags(), copy: true })) ui.node.close();
      }, true), button("trash-2", "移至最近删除", async () => {
        if (await mutate("collection.trash", { ids: [item.id] })) ui.node.close();
      }, true));
      details.append(commands);
    }
    ui.submit("完成", async () => {
      const ok = await mutate("collection.bookmark", { id: item?.id, title: name.value, url: url.value, folderId: folder.value, tags: readTags(), copy: Boolean(item && !item.id) });
      if (ok) localStorage.setItem("ego-bookmark-folder", folder.value);
      return ok;
    });
  }
  function moveDialog(ids) {
    const ui = dialog(`移动 ${ids.length} 项`);
    const folder = ui.field("目标文件夹", selectFolder("other"));
    ui.submit("移动", () => mutate("collection.libraryMove", { ids, folderId: folder.value }));
  }
  async function trash(ids) {
    const affected = new Set(ids);
    for (let size = -1; size !== affected.size;) {
      size = affected.size;
      for (const folder of activeFolders()) if (affected.has(folder.parentId)) affected.add(folder.id);
    }
    const count = data.items.filter(item => !item.deletedAt && (affected.has(item.id) || affected.has(item.folderId))).length;
    if (!await confirm("移至最近删除", `将移除所选项目，涉及 ${count} 条收藏。之后可以恢复。`, "移除")) return;
    if (await mutate("collection.trash", { ids })) selected.clear();
    render();
  }
  async function openFolder(folder) {
    const items = children(folder.id).filter(entry => !isFolder(entry) && entry.sourceUrl);
    if (items.length > 10 && !await confirm("打开文件夹", `将打开 ${items.length} 个标签页。`, "打开")) return;
    for (const item of items) await open(item);
  }
  function actions(entry) {
    if (entry.deletedAt) return [["rotate-ccw", "恢复", () => mutate("collection.restore", { ids: [entry.id] })]];
    const folder = isFolder(entry);
    const list = folder ? [
      ["folder-open", "打开文件夹", () => manageFolder(entry.id)],
      ["folder-plus", "新建子文件夹", () => folderDialog(undefined, entry.id)],
      ["external-link", "打开本层全部网页", () => openFolder(entry)],
    ] : entry.sourceUrl ? [["external-link", "在新标签打开", () => open(entry)]] : [];
    if (folder && !entry.parentId) return list;
    list.push(["pencil", "编辑", () => folder ? folderDialog(entry) : entry.kind === "bookmark" ? bookmarkDialog(entry) : editExcerpt(entry)],
      ["folder-input", "移动", () => moveDialog([entry.id])],
      ["trash-2", "移至最近删除", () => trash([entry.id])]);
    if (!folder && entry.kind !== "bookmark" && entry.sourceUrl) list.push(["bookmark", "另存为书签", () => bookmarkDialog({ ...entry, id: undefined })]);
    const parentId = folder ? entry.parentId : entry.folderId;
    const siblings = children(parentId);
    const index = siblings.findIndex(item => item.id === entry.id);
    if (index > 0) list.push(["arrow-up", "上移", () => mutate("collection.libraryMove", { ids: [entry.id], folderId: parentId, beforeId: siblings[index - 1].id })]);
    if (index >= 0 && index < siblings.length - 1) list.push(["arrow-down", "下移", () => mutate("collection.libraryMove", { ids: [entry.id], folderId: parentId, ...(siblings[index + 2] ? { beforeId: siblings[index + 2].id } : {}) })]);
    return list;
  }
  function showMenu(anchor, entries) {
    popupAnchor = anchor;
    popup.classList.remove("bm-folder-popup");
    popup.replaceChildren();
    for (const [name, label, action] of entries) {
      const control = button(name, label, async () => { popup.hidden = true; await action(); }, true);
      control.setAttribute("role", "menuitem");
      popup.append(control);
    }
    popup.hidden = false;
    positionPopup(anchor);
    icons();
    popup.querySelector("button")?.focus();
  }
  function positionPopup(anchor) {
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(rect.bottom + 3, window.innerHeight - popup.offsetHeight - 8))}px`;
  }
  popup.addEventListener("keydown", event => {
    const controls = [...popup.querySelectorAll("button")];
    const index = controls.indexOf(document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 :
        (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
      controls[next]?.focus();
    }
  });
  function drag(node, entry, targetFolder) {
    const before = event => {
      const rect = node.getBoundingClientRect();
      return !targetFolder && (!isFolder(entry) || event.clientY < rect.top + 7 || event.clientX < rect.left + 9);
    };
    if (entry && !entry.deletedAt && !(isFolder(entry) && !entry.parentId)) {
      node.draggable = true;
      node.addEventListener("dragstart", event => {
        event.dataTransfer.setData("application/x-ego-bookmarks", JSON.stringify(selected.has(entry.id) ? [...selected] : [entry.id]));
        event.dataTransfer.effectAllowed = "move";
      });
    }
    node.addEventListener("dragover", event => {
      if (event.dataTransfer.types.includes("application/x-ego-bookmarks")) {
        event.preventDefault();
        node.classList.add("bm-drop");
        node.classList.toggle("bm-drop-before", before(event));
      }
    });
    node.addEventListener("dragleave", () => node.classList.remove("bm-drop", "bm-drop-before"));
    node.addEventListener("drop", event => {
      const raw = event.dataTransfer.getData("application/x-ego-bookmarks");
      if (!raw) return;
      event.preventDefault();
      event.stopPropagation();
      node.classList.remove("bm-drop", "bm-drop-before");
      void run(async () => {
        const ids = JSON.parse(raw);
        const insertBefore = before(event);
        if (insertBefore && ids.includes(entry.id)) return;
        const folderId = targetFolder || (isFolder(entry) ? insertBefore ? entry.parentId : entry.id : entry.folderId);
        await mutate("collection.libraryMove", { ids, folderId, ...(insertBefore ? { beforeId: entry.id } : {}) });
      });
    });
  }
  function renderTree() {
    tree.replaceChildren();
    for (const [id, name, symbol] of [["all", "全部收藏", "book-marked"], ["bookmarks", "网页书签", "bookmark"], ["excerpts", "文字摘录", "text-select"], ["legacy", "待整理", "inbox"], ["trash", "最近删除", "trash-2"]]) {
      const control = button(symbol, name, () => navigate(id), true);
      control.classList.toggle("active", view === id);
      tree.append(control);
    }
    tree.append(el("div", "bm-tree-divider"));
    function branch(parentId, depth) {
      for (const folder of sorted(activeFolders().filter(entry => entry.parentId === parentId))) {
        const line = el("div", "bm-tree-line");
        line.style.paddingLeft = `${Math.min(depth, 6) * 12}px`;
        const control = button(folder.id === "bar" ? "panel-top" : "folder", folder.name, () => navigate(folder.id), true);
        control.classList.toggle("active", view === folder.id);
        control.title = path(folder.id);
        control.addEventListener("contextmenu", event => { event.preventDefault(); showMenu(control, actions(folder)); });
        drag(control, folder, folder.id);
        if (activeFolders().some(entry => entry.parentId === folder.id)) {
          const toggle = button(collapsed.has(folder.id) ? "chevron-right" : "chevron-down", `${collapsed.has(folder.id) ? "展开" : "收起"} ${folder.name}`, () => {
            if (collapsed.has(folder.id)) collapsed.delete(folder.id);
            else collapsed.add(folder.id);
            renderTree();
            icons();
          });
          toggle.setAttribute("aria-expanded", String(!collapsed.has(folder.id)));
          line.append(toggle);
        }
        line.append(control);
        tree.append(line);
        if (!collapsed.has(folder.id)) branch(folder.id, depth + 1);
      }
    }
    branch(null, 0);
  }
  function renderRows() {
    const focusId = rows.contains(document.activeElement) ? document.activeElement.closest("[data-id]")?.dataset.id : null;
    const needle = search.value.trim().toLocaleLowerCase();
    const deleted = view === "trash";
    let entries = deleted ? [...data.folders, ...data.items].filter(entry => entry.deletedAt) :
      folderOf(view) ? children(view) : data.items.filter(item => !item.deletedAt && (view === "all" || (view === "bookmarks" ? item.kind === "bookmark" : view === "legacy" ? !item.kind : item.kind === "excerpt")));
    if (needle) {
      if (!deleted) entries = [...activeFolders().filter(folder => folder.parentId), ...data.items.filter(item => !item.deletedAt)];
      entries = entries.filter(entry => [title(entry), entry.text, entry.sourceUrl, path(entry.folderId || entry.parentId), ...(entry.tags || [])].filter(Boolean).join("\n").toLocaleLowerCase().includes(needle));
    }
    if (tags.value) entries = entries.filter(entry => entry.tags?.includes(tags.value));
    if (sort.value === "manual") sorted(entries);
    if (sort.value === "title") entries.sort((a, b) => title(a).localeCompare(title(b), "zh-CN"));
    if (sort.value === "newest") entries.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    visibleEntries = entries;
    const ids = new Set(entries.map(entry => entry.id));
    if (!ids.has(lastFocusedRow)) lastFocusedRow = "";
    selected = new Set([...selected].filter(id => ids.has(id)));
    $("#collection-result-count").textContent = `${entries.length} 项`;
    breadcrumb.replaceChildren();
    if (folderOf(view) && !needle) {
      const trail = [];
      for (let folder = folderOf(view); folder; folder = folderOf(folder.parentId)) trail.unshift(folder);
      for (const [index, folder] of trail.entries()) {
        if (index) breadcrumb.append(icon("chevron-right"));
        const crumb = el("button", "bm-crumb", folder.name);
        crumb.type = "button";
        crumb.addEventListener("click", () => navigate(folder.id));
        breadcrumb.append(crumb);
      }
    } else breadcrumb.textContent = needle ? "搜索结果" : ({ all: "全部收藏", bookmarks: "网页书签", excerpts: "文字摘录", legacy: "待整理", trash: "最近删除" })[view];
    batch.replaceChildren();
    const all = el("input");
    all.type = "checkbox";
    all.title = "选择当前结果";
    all.setAttribute("aria-label", all.title);
    all.checked = entries.length > 0 && entries.every(entry => selected.has(entry.id));
    all.indeterminate = selected.size > 0 && !all.checked;
    all.addEventListener("change", () => { selected = all.checked ? ids : new Set(); renderRows(); });
    batch.append(all, el("span", "", selected.size ? `已选 ${selected.size} 项` : "全选"));
    if (selected.size) {
      if (deleted) batch.append(button("rotate-ccw", "恢复所选", () => mutate("collection.restore", { ids: [...selected] })));
      else batch.append(button("folder-input", "移动所选", () => moveDialog([...selected])), button("trash-2", "删除所选", () => trash([...selected])));
    } else if (folderOf(view)) {
      const folder = folderOf(view);
      batch.append(button("ellipsis", "文件夹操作", () => showMenu(batch, actions(folder))));
    }
    rows.replaceChildren();
    if (!entries.length) rows.append(el("p", "bm-empty", needle ? "没有匹配的收藏" : deleted ? "最近删除为空" : "这里还没有收藏"));
    for (const entry of entries) {
      const row = el("div", "bm-row");
      row.dataset.id = entry.id;
      row.setAttribute("role", "listitem");
      row.classList.toggle("is-selected", selected.has(entry.id));
      row.tabIndex = lastFocusedRow === entry.id || (!lastFocusedRow && entries[0] === entry) ? 0 : -1;
      row.addEventListener("focus", () => { lastFocusedRow = entry.id; });
      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.setAttribute("aria-label", `选择 ${title(entry)}`);
      checkbox.checked = selected.has(entry.id);
      checkbox.addEventListener("click", event => {
        if (event.shiftKey && lastFocusedRow) {
          const start = entries.findIndex(item => item.id === lastFocusedRow);
          const end = entries.indexOf(entry);
          if (start >= 0) for (const item of entries.slice(Math.min(start, end), Math.max(start, end) + 1)) selected.add(item.id);
        } else if (checkbox.checked) selected.add(entry.id);
        else selected.delete(entry.id);
        lastFocusedRow = entry.id;
        renderRows();
      });
      const name = el("button", "bm-entry");
      name.type = "button";
      name.title = title(entry);
      name.append(entryIcon(entry), el("span", "", title(entry)));
      name.addEventListener("click", () => run(() => entry.deletedAt ? undefined : isFolder(entry) ? navigate(entry.id) : entry.sourceUrl ? open(entry) : editExcerpt(entry)));
      const meta = el("div", "bm-meta");
      if (!isFolder(entry)) {
        const source = el("span", "", entry.sourceUrl || entry.text);
        source.title = entry.sourceUrl || entry.text;
        const location = el("button", "bm-path", path(entry.folderId));
        location.type = "button";
        location.title = path(entry.folderId);
        location.addEventListener("click", () => { search.value = ""; navigate(entry.folderId || "other"); });
        meta.append(source, location);
        if (entry.kind !== "bookmark" && entry.text !== title(entry)) {
          const excerpt = el("span", "", entry.text);
          excerpt.title = entry.text;
          meta.prepend(excerpt);
        }
        if (entry.tags?.length) meta.append(el("span", "", entry.tags.join(" · ")));
      } else meta.append(el("span", "", path(entry.parentId)));
      const menu = button("ellipsis", "更多操作", () => showMenu(menu, actions(entry)));
      menu.classList.add("bm-menu-trigger");
      row.append(checkbox, name, meta, menu);
      row.addEventListener("contextmenu", event => { event.preventDefault(); showMenu(menu, actions(entry)); });
      if (!deleted && sort.value === "manual" && !needle) drag(row, entry);
      rows.append(row);
    }
    icons();
    if (focusId) rows.querySelector(`[data-id="${focusId}"]`)?.focus({ preventScroll: true });
  }
  rows.addEventListener("keydown", event => {
    if (event.target.matches("input, select, textarea")) return;
    const row = event.target.closest(".bm-row");
    if (!row) return;
    const entry = visibleEntries.find(item => item.id === row.dataset.id);
    const index = visibleEntries.indexOf(entry);
    if (!entry) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); selected = new Set(visibleEntries.map(item => item.id)); renderRows();
    } else if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? visibleEntries.length - 1 : Math.max(0, Math.min(visibleEntries.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      if (event.shiftKey) {
        selected.add(entry.id);
        selected.add(visibleEntries[nextIndex].id);
        renderRows();
      }
      rows.querySelector(`[data-id="${visibleEntries[nextIndex].id}"]`)?.focus();
    } else if (event.key === "Delete" && !entry.deletedAt) {
      event.preventDefault(); void run(() => trash(selected.has(entry.id) ? [...selected] : [entry.id]));
    } else if (event.key === "F2" && !entry.deletedAt) {
      event.preventDefault(); void run(() => isFolder(entry) ? folderDialog(entry) : entry.kind === "bookmark" ? bookmarkDialog(entry) : editExcerpt(entry));
    } else if (event.key === "Enter" && event.target === row) {
      event.preventDefault(); row.querySelector(".bm-entry").click();
    } else if (event.key === " " && event.target === row) {
      event.preventDefault(); row.querySelector('input[type="checkbox"]').click();
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); showMenu(row, actions(entry));
    }
  });
  function barButton(entry) {
    const control = button(isFolder(entry) ? "folder" : "bookmark", title(entry), () => {
      if (isFolder(entry)) showFolderMenu(control, entry);
      else return open(entry);
    }, true);
    control.classList.add("bm-menu-trigger", "bm-bar-link");
    control.firstChild.replaceWith(entryIcon(entry));
    control.title = entry.sourceUrl || path(entry.id);
    control.addEventListener("contextmenu", event => { event.preventDefault(); showMenu(control, actions(entry)); });
    drag(control, entry);
    return control;
  }
  function showFolderMenu(anchor, folder) {
    const entries = children(folder.id).filter(item => isFolder(item) || item.kind === "bookmark").map(item =>
      [isFolder(item) ? "folder" : "bookmark", title(item), () => isFolder(item) ? showFolderMenu(anchor, item) : open(item)]);
    entries.push(["settings-2", "管理此文件夹", () => manageFolder(folder.id)]);
    showMenu(anchor, entries);
    popup.classList.add("bm-folder-popup");
    const heading = el("div", "bm-folder-menu-head");
    if (folder.parentId) heading.append(button("arrow-left", "返回上级文件夹", () => showFolderMenu(anchor, folderOf(folder.parentId))));
    heading.append(el("strong", "", folder.name));
    popup.prepend(heading);
    const controls = [...popup.querySelectorAll('[role="menuitem"]')];
    children(folder.id).filter(item => isFolder(item) || item.kind === "bookmark").forEach((item, index) => {
      const control = controls[index];
      if (!control) return;
      control.firstChild.replaceWith(entryIcon(item));
      if (isFolder(item)) { control.append(icon("chevron-right")); control.setAttribute("aria-haspopup", "menu"); }
      control.title = item.sourceUrl || path(item.id);
      control.addEventListener("contextmenu", event => { event.preventDefault(); showMenu(anchor, actions(item)); });
    });
    icons();
    positionPopup(anchor);
  }
  function renderBar() {
    const list = $("#favorites-list");
    list.replaceChildren();
    const entries = children("bar").filter(entry => isFolder(entry) || entry.kind === "bookmark");
    for (const entry of entries) list.append(barButton(entry));
    if (!entries.length) list.append(el("span", "favorites-empty", "收藏栏"));
    const overflow = button("chevrons-right", "更多收藏", () => showMenu(overflow, hidden.map(entry =>
      [isFolder(entry) ? "folder" : "bookmark", title(entry), () => isFolder(entry) ? showFolderMenu(overflow, entry) : open(entry)])));
    overflow.classList.add("bm-menu-trigger");
    list.append(overflow);
    icons();
    let hidden = [];
    const controls = [...list.children].filter(node => node !== overflow);
    const available = list.clientWidth;
    let used = 34;
    controls.forEach((node, index) => {
      used += node.getBoundingClientRect().width + 3;
      if (available > 0 && used > available && entries[index]) { node.hidden = true; hidden.push(entries[index]); }
    });
    overflow.hidden = hidden.length === 0;
  }
  drag($("#favorites-list"), null, "bar");
  new ResizeObserver(() => renderBar()).observe($("#favorites-list"));
  function render() {
    if (folderOf(view)?.deletedAt) view = "all";
    const currentTag = tags.value;
    tags.replaceChildren(new Option("全部标签", ""));
    for (const tag of [...new Set(data.items.filter(item => !item.deletedAt).flatMap(item => item.tags || []))].sort()) tags.add(new Option(tag, tag));
    tags.hidden = tags.options.length === 1;
    tags.value = [...tags.options].some(option => option.value === currentTag) ? currentTag : "";
    renderTree();
    renderRows();
    renderBar();
    renderPanel();
    positionPanel();
  }
  async function savePage(tab, quick = true) {
    if (savingPage || !tab?.url || tab.url.startsWith("ego:")) return;
    closePanel(false);
    savingPage = true;
    try {
      const existing = data.items.find(item => !item.deletedAt && item.kind === "bookmark" && item.sourceUrl === tab.url);
      if (existing) { bookmarkDialog(existing, false, quick); return; }
      const preferred = localStorage.getItem("ego-bookmark-folder") || "other";
      const item = await invoke("collection.bookmark", { title: tab.title || tab.url, url: tab.url, faviconUrl: tab.faviconUrl, folderId: activeFolders().some(folder => folder.id === preferred) ? preferred : "other" });
      data = await invoke("collection.library");
      await refresh();
      bookmarkDialog(item, true, quick);
    } catch (error) { toast(errorText(error), true); }
    finally { savingPage = false; }
  }
  return {
    setData(snapshot) { data = snapshot; },
    render,
    renderBar,
    togglePanel,
    toggleBar,
    openOtherFavorites() {
      const anchor = $("#favorites-all");
      if (!popup.hidden && popupAnchor === anchor) popup.hidden = true;
      else showFolderMenu(anchor, folderOf("other"));
    },
    onViewChange(name) {
      popup.hidden = true;
      if (name !== "start") {
        closePanel(false);
        for (const quick of document.querySelectorAll(".bm-quick-save[open]")) quick.close();
      }
    },
    exportSelection() {
      const ids = new Set();
      const folderIds = new Set();
      function collect(entry) {
        if (entry.deletedAt) return;
        if (isFolder(entry)) {
          if (folderIds.has(entry.id)) return;
          folderIds.add(entry.id);
          children(entry.id).forEach(collect);
        } else ids.add(entry.id);
      }
      visibleEntries.forEach(collect);
      if (!search.value && !tags.value && view === "all") activeFolders().forEach(collect);
      if (folderOf(view)) folderIds.add(view);
      return { ids: [...ids], folderIds: [...folderIds] };
    },
    savePage,
  };
}
