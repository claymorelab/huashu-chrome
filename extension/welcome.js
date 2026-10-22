// 首装欢迎页：实时探测本地端，连上就变绿。
// 本地端由 Claymore Piko 桌面 App 自带，Bot 第一次用浏览器时拉起，用户不用另装什么。

const copy = (btnId, srcId) => {
  const btn = document.getElementById(btnId);
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(document.getElementById(srcId).textContent); btn.textContent = '已复制'; } catch { btn.textContent = '请手动复制'; }
    setTimeout(() => { btn.textContent = '复制'; }, 1600);
  };
};
copy('copy', 'say');

async function poll() {
  const r = await chrome.runtime.sendMessage({ __hcPopup: 'status' }).catch(() => null);
  if (r?.connected) {
    document.getElementById('step2').classList.add('done');
    document.querySelector('#step2 .n').textContent = '✓';
    document.getElementById('live').classList.add('ok');
    document.getElementById('livetxt').textContent = `已连上 Piko（本地端 v${r.bridge || '?'}）。可以去让 Bot 干活了。`;
    return;
  }
  setTimeout(poll, 2000);
}
poll();
