const status = document.querySelector("#status");
const title = document.querySelector("#tab-title");
const select = document.querySelector("#space");
const adopt = document.querySelector("#adopt");
const takeControl = document.querySelector("#take-control");

const state = await chrome.runtime.sendMessage({ method: "ui.state" });
title.textContent = state.currentTab?.title || "没有可授权的标签";
for (const space of state.spaces || []) {
  const option = document.createElement("option");
  option.value = space.taskId;
  option.textContent = `${space.name} (${space.tabCount})`;
  select.append(option);
}
adopt.disabled = !state.connected || !state.currentTab || !state.spaces?.length;
takeControl.disabled = !state.connected || !state.spaces?.length;
status.textContent = state.error || !state.connected ? "未连接" : "已连接";

adopt.addEventListener("click", async () => {
  adopt.disabled = true;
  const result = await chrome.runtime.sendMessage({
    method: "ui.adoptCurrentTab",
    taskId: select.value,
  });
  status.textContent = result.error ? "授权失败" : "已授权";
  if (result.error) adopt.disabled = false;
});

takeControl.addEventListener("click", async () => {
  takeControl.disabled = true;
  const result = await chrome.runtime.sendMessage({
    method: "ui.takeControl",
    taskId: select.value,
  });
  status.textContent = result.error ? "接管失败" : "用户控制中";
  if (result.error) takeControl.disabled = false;
});
