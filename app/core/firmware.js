const { L } = require('../renderer/i18n');

// Known-problem firmware. Add entries as new issues become known.
// model: regex on the drive model; firmware: exact versions with the problem.
const KNOWN_ISSUES = [
  {
    model: /Samsung SSD 980 PRO/i, firmware: ['3B2QGXA7'], fixed: '5B2QGXA7',
    issue: ['此固件会让健康度快速下降，甚至变成只读。', 'This firmware makes health drop quickly and can turn the drive read-only. '],
  },
  {
    model: /Samsung SSD 990 PRO/i, firmware: ['0B2QJXD7', '1B2QJXD7'], fixed: '4B2QJXD7',
    issue: ['此固件会让健康度（寿命已用）异常快速增加。', 'This firmware makes wear (percentage used) rise abnormally fast. '],
  },
  {
    model: /Crucial_CT\d+M4|M4-CT\d+/i, firmware: ['0001', '0002', '0009'], fixed: '0309',
    issue: ['通电约 5184 小时后会反复断开（5184 小时问题）。', 'The drive keeps disconnecting after about 5184 power-on hours (5184-hour bug). '],
  },
  {
    model: /ST3500320AS|ST3640330AS|ST3750330AS|ST31000340AS|ST31500341AS/i,
    firmware: ['SD15', 'SD16', 'SD17', 'SD18', 'SD19'], fixed: 'SD1A',
    issue: ['重启后可能无法识别硬盘（BSY 锁死问题）。', 'The drive may not be detected after a restart (BSY lock-up bug). '],
  },
  {
    model: /WD_BLACK SN770|WDS\d+G3X0E/i, firmware: ['731030WD'], fixed: '731130WD',
    issue: ['在 Windows 11 24H2 上可能蓝屏。', 'May cause blue screens on Windows 11 24H2. '],
  },
];

function firmwareWarning(disk) {
  const fw = String(disk.firmware || '').trim().toUpperCase();
  for (const k of KNOWN_ISSUES) {
    if (k.model.test(disk.model || '') && k.firmware.includes(fw)) {
      return { firmware: fw, fixed: k.fixed, text: L(`固件 ${fw} 有已知问题：${k.issue[0]}请更新到 ${k.fixed} 或更新版本。`, `Firmware ${fw} has a known problem: ${k.issue[1]}Update to ${k.fixed} or newer.`) };
    }
  }
  return null;
}

module.exports = { firmwareWarning, KNOWN_ISSUES };
