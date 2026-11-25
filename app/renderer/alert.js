// Alert popup shown by the tray monitor. Customer-facing: plain words, one big WhatsApp button.
const $ = (s) => document.querySelector(s);
function esc(v) { return String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const { L } = window.I18N;

function render(p) {
  window.I18N.setLang(p.lang);
  document.title = L('smartPC 硬盘提醒', 'smartPC drive alert');
  $('#sub').textContent = L('smartPC 硬盘监控', 'smartPC drive monitor');
  $('#tip').innerHTML = L('请先<b>备份重要资料</b>（照片、文件），再联系我们检查。', 'Please <b>back up important files</b> (photos, documents) first, then contact us for a check.');
  $('#wa').textContent = L('WhatsApp 联系我们', 'Contact us on WhatsApp');
  $('#open').textContent = L('查看详情', 'Details');
  $('#ok').textContent = L('知道了', 'OK');
  const bad = p.alerts.some(a => a.severity === 'bad');
  const hotOnly = p.alerts.every(a => a.kind === 'hot');
  document.body.classList.toggle('is-bad', bad);
  $('#title').textContent = bad ? L('硬盘出现问题', 'Drive problem found') : hotOnly ? L('硬盘温度过高', 'Drive is overheating') : L('硬盘需要注意', 'Drive needs attention');
  $('#list').innerHTML = p.alerts.map(a => `<div class="alert-item ${a.severity}">
      <b>${esc(a.model)}${a.letters?.length ? ` <span class="muted">(${esc(a.letters.join(' '))})</span>` : ''}</b>
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
