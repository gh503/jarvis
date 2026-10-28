'use strict';

// Tabs follow the WAI-ARIA automatic activation keyboard pattern.
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
function activateTab(tab, focus = false) {
  tabs.forEach((item) => {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(item.getAttribute('aria-controls'));
    if (panel) panel.hidden = !selected;
  });
  if (focus) tab.focus();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', (event) => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      activateTab(tabs[next], true);
    }
  });
});

const copyButton = document.getElementById('copy-command');
const copyStatus = document.getElementById('copy-status');
copyButton.addEventListener('click', async () => {
  const command = document.getElementById('install-command');
  try {
    await navigator.clipboard.writeText(command.textContent.trim());
    copyStatus.textContent = '已复制安装命令。请先确认环境要求，再在终端执行。';
    copyButton.textContent = '已复制 ✓';
  } catch {
    // HTTP/file previews may not grant Clipboard API access; select for manual copy.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
    copyStatus.textContent = '自动复制不可用，已选中命令，请使用系统复制操作。';
    copyButton.textContent = '手动复制';
  }
});
