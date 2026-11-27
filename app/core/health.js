const { firmwareWarning } = require('./firmware');
const { L } = require('../renderer/i18n');
const { grade, refurbCheck } = require('./assess');

// Health rules shared by the UI and (later) the PDF report / remote HTTP endpoint.
// Input: one disk object from smartdisk-helper JSON. Output: normalized summary.

const ATA_NAMES = {
  1: '读取错误率', 3: '启动时间', 4: '启停次数', 5: '重映射扇区数', 7: '寻道错误率',
  9: '通电时间', 10: '旋转重试次数', 12: '通电次数', 169: '剩余寿命', 170: '可用保留块',
  171: '编程失败次数', 172: '擦除失败次数', 173: '平均擦写次数', 174: '意外断电次数',
  177: '磨损均衡计数', 180: '未用保留块', 181: '编程失败总数', 182: '擦除失败总数',
  183: 'SATA 降速次数', 184: '端到端错误', 187: '无法修正错误', 188: '命令超时',
  190: '气流温度', 192: '断电回缩次数', 193: '磁头加载次数', 194: '温度',
  195: 'ECC 修正次数', 196: '重映射事件数', 197: '待映射扇区数', 198: '无法修正扇区数',
  199: 'UltraDMA CRC 错误', 200: '写入错误率', 231: 'SSD 剩余寿命', 232: '可用保留空间',
  233: '介质磨损指标', 241: '累计写入', 242: '累计读取',
  2: '吞吐性能', 8: '寻道时间性能', 11: '校准重试次数', 13: '软读取错误率', 22: '氦气含量',
  160: '无法修正扇区', 161: '有效备用块', 163: '初始坏块', 164: '总擦写次数', 165: '最大擦写次数',
  166: '最小擦写次数', 167: '平均坏块', 168: '最大擦写寿命', 175: '断电保护故障', 176: '擦除失败次数',
  178: '已用保留块', 179: '已用保留块总数', 189: '高飞写入', 191: '震动感应错误', 201: '软读取错误',
  206: '磁头飞行高度', 220: '盘片偏移', 222: '磁头加载时间', 223: '加载重试次数', 224: '加载摩擦力',
  225: '加载周期次数', 226: '磁头加载耗时', 235: '断电恢复次数', 240: '磁头飞行时间', 246: '累计写入',
  250: '读取重试次数', 252: '坏块计数', 254: '自由落体保护',
};

const ATA_NAMES_EN = {
  1: 'Read Error Rate', 2: 'Throughput Performance', 3: 'Spin-Up Time', 4: 'Start/Stop Count', 5: 'Reallocated Sectors Count',
  7: 'Seek Error Rate', 8: 'Seek Time Performance', 9: 'Power-On Hours', 10: 'Spin Retry Count', 11: 'Calibration Retry Count',
  12: 'Power Cycle Count', 13: 'Soft Read Error Rate', 22: 'Helium Level', 160: 'Uncorrectable Sectors', 161: 'Valid Spare Blocks',
  163: 'Initial Bad Blocks', 164: 'Total Erase Count', 165: 'Max Erase Count', 166: 'Min Erase Count', 167: 'Average Bad Blocks',
  168: 'Max Erase Count Spec', 169: 'Remaining Life', 170: 'Available Reserved Blocks', 171: 'Program Fail Count',
  172: 'Erase Fail Count', 173: 'Average Erase Count', 174: 'Unexpected Power Loss Count', 175: 'Power Loss Protection Failure',
  176: 'Erase Fail Count', 177: 'Wear Leveling Count', 178: 'Used Reserved Blocks', 179: 'Used Reserved Blocks Total',
  180: 'Unused Reserved Blocks', 181: 'Program Fail Count Total', 182: 'Erase Fail Count Total', 183: 'SATA Downshift Count',
  184: 'End-to-End Error', 187: 'Reported Uncorrectable Errors', 188: 'Command Timeout', 189: 'High Fly Writes',
  190: 'Airflow Temperature', 191: 'G-Sense Error Rate', 192: 'Power-Off Retract Count', 193: 'Load Cycle Count',
  194: 'Temperature', 195: 'ECC Corrected Count', 196: 'Reallocation Event Count', 197: 'Current Pending Sectors',
  198: 'Uncorrectable Sector Count', 199: 'UltraDMA CRC Errors', 200: 'Write Error Rate', 201: 'Soft Read Error Rate',
  206: 'Flying Height', 220: 'Disk Shift', 222: 'Loaded Hours', 223: 'Load Retry Count', 224: 'Load Friction',
  225: 'Load Cycle Count', 226: 'Load-in Time', 231: 'SSD Life Left', 232: 'Available Reserved Space',
  233: 'Media Wearout Indicator', 235: 'Power Loss Recovery Count', 240: 'Head Flying Hours', 241: 'Total LBAs Written',
  242: 'Total LBAs Read', 246: 'Total Host Writes', 250: 'Read Error Retry Rate', 252: 'Bad Block Count', 254: 'Free Fall Protection',
};

// Some raw values pack several numbers into the 6 raw bytes; show only the meaningful part.
const TEMP_IDS = [190, 194];
function rawValue(id, raw) {
  if (TEMP_IDS.includes(id)) return raw % 256;              // byte 0 = current °C (others: min/max)
  if (id === 9) return raw % 4294967296;                     // hours in the low 32 bits
  return raw;
}
function rawText(id, raw) {
  if (TEMP_IDS.includes(id)) {
    const cur = raw % 256, lo = Math.floor(raw / 65536) % 256, hi = Math.floor(raw / 4294967296) % 256;
    return hi > cur && lo > 0 && lo <= cur ? L(`${cur} °C（最低 ${lo} / 最高 ${hi}）`, `${cur} °C (min ${lo} / max ${hi})`) : `${cur} °C`;
  }
  return Number(rawValue(id, raw)).toLocaleString();
}

// Attributes whose raw value > 0 indicates physical damage.
const CRITICAL_RAW = [5, 196, 197, 198];
const REALLOC_BAD = 100;   // this many reallocated sectors: the drive is wearing out fast, replace it

function attrName(id) { return L(ATA_NAMES[id], ATA_NAMES_EN[id]) || L(`厂商自定义 (${id})`, `Vendor specific (${id})`); }

function evaluateAta(disk) {
  const attrs = disk.ata?.attributes || [];
  const byId = Object.fromEntries(attrs.map(a => [a.id, a]));
  let health = 100;
  let status = 'good';
  const reasons = [];

  for (const a of attrs) {
    a.name = attrName(a.id);
    a.state = 'ok';
    if (a.threshold > 0 && a.current <= a.threshold) {
      a.state = 'bad'; status = 'bad';
      reasons.push(L(`${a.name} 低于阈值`, `${a.name} below threshold`));
    }
  }
  for (const id of CRITICAL_RAW) {
    const a = byId[id];
    if (a && a.raw > 0) {
      // Pending (197) and uncorrectable (198) sectors are data that can no longer be read: the drive is failing.
      // Reallocated sectors (5, 196) were already replaced by spares: a warning, until there are many of them.
      const failing = id === 197 || id === 198 || a.raw >= REALLOC_BAD;
      a.state = failing ? 'bad' : a.state === 'ok' ? 'warn' : a.state;
      if (failing) status = 'bad'; else if (status === 'good') status = 'warn';
      health -= Math.min(40, 5 + a.raw);   // tweak to taste
      reasons.push(`${a.name}: ${a.raw}`);
    }
  }
  // Reported uncorrectable errors (187): reads the drive could not fix.
  if (byId[187]?.raw > 0) {
    if (byId[187].state === 'ok') byId[187].state = 'warn';
    if (status === 'good') status = 'warn';
    health -= Math.min(20, 2 * byId[187].raw);
    reasons.push(`${byId[187].name}: ${byId[187].raw}`);
  }
  // SSD wear indicators (normalized current value is the remaining life %).
  for (const id of [231, 169, 233, 177]) {
    if (byId[id] && byId[id].current <= 100) { health = Math.min(health, byId[id].current); break; }
  }
  if (clamp(health) === 0 && status !== 'bad') status = 'bad';   // nothing left
  const t = byId[194] || byId[190];
  return {
    health: clamp(status === 'bad' ? Math.min(health, 10) : health),
    status, reasons,
    temperatureC: t ? rawValue(t.id, t.raw) : null,
    powerOnHours: byId[9] ? rawValue(9, byId[9].raw) : null,
    powerCycles: byId[12] ? byId[12].raw : null,
    rows: attrs.map(a => ({
      id: a.id, name: a.name, current: a.current, worst: a.worst,
      threshold: a.threshold, raw: a.raw, rawText: rawText(a.id, a.raw), state: a.state,
    })),
  };
}

function evaluateNvme(disk) {
  const n = disk.nvme;
  let status = 'good';
  const reasons = [];
  if (n.criticalWarning) { status = 'bad'; reasons.push(L('严重警告位', 'Critical warning bits') + `: 0x${n.criticalWarning.toString(16)}`); }
  if (n.availableSpare < n.spareThreshold) { status = 'bad'; reasons.push(L('备用空间低于阈值', 'Available spare below threshold')); }
  if (n.mediaErrors > 0 && status === 'good') { status = 'warn'; reasons.push(L('介质错误', 'Media errors') + `: ${n.mediaErrors}`); }
  if (n.percentageUsed >= 100) { status = 'bad'; reasons.push(L('寿命已用完（100%）', 'Rated life used up (100%)')); }
  else if (n.percentageUsed >= 90 && status === 'good') { status = 'warn'; reasons.push(L('寿命已用超过 90%', 'Over 90% of rated life used')); }

  const tb = units => (units * 512000 / 1e12).toFixed(2) + ' TB'; // 1 unit = 1000 * 512 bytes
  const st = v => (v === 'bad' ? 'bad' : v === 'warn' ? 'warn' : 'ok');
  const rows = [
    ['01', L('严重警告', 'Critical warning'), n.criticalWarning, n.criticalWarning ? 'bad' : 'ok'],
    ['02', L('温度', 'Temperature'), `${n.temperatureC} °C`, n.temperatureC >= 70 ? 'warn' : 'ok'],
    ['03', L('可用备用空间', 'Available spare'), `${n.availableSpare} %`, n.availableSpare < n.spareThreshold ? 'bad' : 'ok'],
    ['04', L('备用空间阈值', 'Spare threshold'), `${n.spareThreshold} %`, 'ok'],
    ['05', L('寿命已用', 'Percentage used'), `${n.percentageUsed} %`, n.percentageUsed >= 90 ? 'warn' : 'ok'],
    ['06', L('累计读取', 'Data read'), tb(n.dataUnitsRead), 'ok'],
    ['07', L('累计写入', 'Data written'), tb(n.dataUnitsWritten), 'ok'],
    ['08', L('主机读命令', 'Host read commands'), n.hostReads, 'ok'],
    ['09', L('主机写命令', 'Host write commands'), n.hostWrites, 'ok'],
    ['0A', L('控制器忙碌时间', 'Controller busy time'), `${n.controllerBusyMinutes} ${L('分钟', 'min')}`, 'ok'],
    ['0B', L('通电次数', 'Power cycles'), n.powerCycles, 'ok'],
    ['0C', L('通电时间', 'Power-on hours'), `${n.powerOnHours} ${L('小时', 'h')}`, 'ok'],
    ['0D', L('意外断电次数', 'Unsafe shutdowns'), n.unsafeShutdowns, 'ok'],
    ['0E', L('介质与数据完整性错误', 'Media and data integrity errors'), n.mediaErrors, n.mediaErrors ? 'warn' : 'ok'],
    ['0F', L('错误日志条目数', 'Error log entries'), n.errorLogEntries, 'ok'],
  ].map(([id, name, value, state]) => ({ id, name, value, state: st(state) }));

  const health = clamp(100 - n.percentageUsed);
  return {
    health: status === 'bad' ? Math.min(health, 10) : health,
    status, reasons,
    temperatureC: n.temperatureC,
    powerOnHours: n.powerOnHours,
    powerCycles: n.powerCycles,
    rows,
  };
}

// Interface link: what the drive is running at vs what it supports.
const SATA_GBPS = { 1: '1.5 Gb/s', 2: '3 Gb/s', 3: '6 Gb/s' };
const PCIE_GEN = { 1: '1.0', 2: '2.0', 3: '3.0', 4: '4.0', 5: '5.0', 6: '6.0' };
function linkInfo(disk) {
  const l = disk.link;
  if (!l) return null;
  if (l.kind === 'sata') {
    const text = l.cur ? `SATA ${SATA_GBPS[l.cur]}` : 'SATA';
    let note = '', state = 'ok';
    if (l.cur && l.max && l.cur < l.max) {
      state = 'warn';
      note = L(`硬盘支持 ${SATA_GBPS[l.max]}，目前只跑 ${SATA_GBPS[l.cur]}。请检查 SATA 线，或换到主板的 6 Gb/s 接口。`,
        `The drive supports ${SATA_GBPS[l.max]} but runs at ${SATA_GBPS[l.cur]}. Check the SATA cable or move it to a 6 Gb/s port.`);
    }
    return { text, max: l.max ? `SATA ${SATA_GBPS[l.max]}` : '', note, state };
  }
  const fmt = (g, w) => g ? `PCIe ${PCIE_GEN[g] || g} x${w || '?'}` : '';
  const text = fmt(l.cur, l.curWidth) || 'PCIe';
  let note = '', state = 'ok';
  if (l.curWidth && l.maxWidth && l.curWidth < l.maxWidth) {
    state = 'warn';
    note = L(`只用了 ${l.curWidth} 条通道（支持 ${l.maxWidth} 条），速度会变慢。请检查是否插在共享通道或较低速的 M.2 插槽。`,
      `Running on ${l.curWidth} lanes (supports ${l.maxWidth}), so it is slower. Check for a shared-lane or slower M.2 slot.`);
  } else if (l.cur && l.max && l.cur < l.max) {
    state = 'info';
    note = L(`SSD 支持 PCIe ${PCIE_GEN[l.max]}，目前是 PCIe ${PCIE_GEN[l.cur]}。可能是主板插槽只支持较低版本，或 SSD 正处于省电状态（测速时再确认）。`,
      `The SSD supports PCIe ${PCIE_GEN[l.max]} but is at PCIe ${PCIE_GEN[l.cur]}. The slot may be older, or the SSD is in power-saving mode (check during a benchmark).`);
  }
  return { text, max: fmt(l.max, l.maxWidth), note, state };
}

// NVMe DRAM: a drive that asks the PC for a Host Memory Buffer (HMB) has no DRAM cache of its own.
function dramInfo(disk) {
  const h = disk.hmb;
  if (!h || disk.bus !== 'nvme') return null;
  if (h.prefKiB > 0) {
    const mb = Math.round(h.prefKiB / 1024);
    return { has: false, hmbMB: mb, text: L(`无（用 HMB ${mb} MB）`, `No (HMB ${mb} MB)`) };
  }
  return { has: true, hmbMB: 0, text: L('有', 'Yes') };
}

function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))); }

function evaluate(disk) {
  const base = !disk.smartOk
    ? { health: null, status: 'unknown', reasons: [disk.error || L('无法读取 SMART', 'SMART could not be read')], temperatureC: null, rows: [] }
    : disk.nvme ? evaluateNvme(disk) : evaluateAta(disk);
  base.link = linkInfo(disk);
  base.dram = dramInfo(disk);
  base.firmwareWarning = firmwareWarning(disk);
  base.kind = disk.rpm === 1 ? 'SSD' : disk.rpm > 1 ? `HDD ${disk.rpm} RPM` : '';
  base.refurb = refurbCheck(disk, base);
  base.grade = grade(disk, base);
  return base;
}

module.exports = { evaluate, attrName, rawValue };
