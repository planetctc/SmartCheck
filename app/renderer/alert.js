// Alert popup shown by the tray monitor. Customer-facing: plain words, one big WhatsApp button.
const $ = (s) => document.querySelector(s);
function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function render(p) {
  const bad = p.alerts.some(a => a.severity === 'bad');
  const hotOnly = p.alerts.every(a => a.kind === 'hot');
  document.body.classList.toggle('is-bad', bad);
  $('#title').textContent = bad ? '硬盘出现问题' : hotOnly ? '硬盘温度过高' : '硬盘需要注意';
  $('#list').innerHTML = p.alerts.map(a => `<div class="alert-item ${a.severity}">
      <b>${esc(a.model)}${a.letters?.length ? ` <span class="muted">（${esc(a.letters.join(' '))}）</span>` : ''}</b>
      <ul>${a.text.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('');
  document.querySelector('.alert-tip').style.display = hotOnly ? 'none' : '';
  $('#wa').hidden = !p.whatsapp;
  $('#shop').textContent = [p.shopName, p.shopContact].filter(Boolean).join(' · ');
}

window.smartdisk.alertData().then(render);
window.smartdisk.onAlert(render);
$('#wa').onclick = () => window.smartdisk.alertAction('whatsapp');
$('#open').onclick = () => window.smartdisk.alertAction('open');
$('#ok').onclick = () => window.smartdisk.alertAction('ok');
