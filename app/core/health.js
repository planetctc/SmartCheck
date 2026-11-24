const { firmwareWarning } = require('./firmware');

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
    return hi > cur && lo > 0 && lo <= cur ? `${cur} °C（最低 ${lo} / 最高 ${hi}）` : `${cur} °C`;
  }
  return Number(rawValue(id, raw)).toLocaleString();
}

// Attributes whose raw value > 0 indicates physical damage.
const CRITICAL_RAW = [5, 196, 197, 198];

function attrName(id) { return ATA_NAMES[id] || `厂商自定义 (${id})`; }

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
      reasons.push(`${a.name} 低于阈值`);
    }
  }
  for (const id of CRITICAL_RAW) {
    const a = byId[id];
    if (a && a.raw > 0) {
      if (a.state === 'ok') a.state = 'warn';
      if (status === 'good') status = 'warn';
      health -= Math.min(40, 5 + a.raw);   // tweak to taste
      reasons.push(`${a.name}: ${a.raw}`);
    }
  }
  // SSD wear indicators (normalized current value is the remaining life %).
  for (const id of [231, 169, 233, 177]) {
    if (byId[id] && byId[id].current <= 100) { health = Math.min(health, byId[id].current); break; }
  }
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
  if (n.criticalWarning) { status = 'bad'; reasons.push(`严重警告位: 0x${n.criticalWarning.toString(16)}`); }
  if (n.availableSpare < n.spareThreshold) { status = 'bad'; reasons.push('备用空间低于阈值'); }
  if (n.mediaErrors > 0 && status === 'good') { status = 'warn'; reasons.push(`介质错误: ${n.mediaErrors}`); }
  if (n.percentageUsed >= 90 && status === 'good') { status = 'warn'; reasons.push('寿命已用超过 90%'); }

  const tb = units => (units * 512000 / 1e12).toFixed(2) + ' TB'; // 1 unit = 1000 * 512 bytes
  const st = v => (v === 'bad' ? 'bad' : v === 'warn' ? 'warn' : 'ok');
  const rows = [
    ['01', '严重警告', n.criticalWarning, n.criticalWarning ? 'bad' : 'ok'],
    ['02', '温度', `${n.temperatureC} °C`, n.temperatureC >= 70 ? 'warn' : 'ok'],
    ['03', '可用备用空间', `${n.availableSpare} %`, n.availableSpare < n.spareThreshold ? 'bad' : 'ok'],
    ['04', '备用空间阈值', `${n.spareThreshold} %`, 'ok'],
    ['05', '寿命已用', `${n.percentageUsed} %`, n.percentageUsed >= 90 ? 'warn' : 'ok'],
    ['06', '累计读取', tb(n.dataUnitsRead), 'ok'],
    ['07', '累计写入', tb(n.dataUnitsWritten), 'ok'],
    ['08', '主机读命令', n.hostReads, 'ok'],
    ['09', '主机写命令', n.hostWrites, 'ok'],
    ['0A', '控制器忙碌时间', `${n.controllerBusyMinutes} 分钟`, 'ok'],
    ['0B', '通电次数', n.powerCycles, 'ok'],
    ['0C', '通电时间', `${n.powerOnHours} 小时`, 'ok'],
    ['0D', '意外断电次数', n.unsafeShutdowns, 'ok'],
    ['0E', '介质与数据完整性错误', n.mediaErrors, n.mediaErrors ? 'warn' : 'ok'],
    ['0F', '错误日志条目数', n.errorLogEntries, 'ok'],
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
      note = `硬盘支持 ${SATA_GBPS[l.max]}，目前只跑 ${SATA_GBPS[l.cur]}。请检查 SATA 线，或换到主板的 6 Gb/s 接口。`;
    }
    return { text, max: l.max ? `SATA ${SATA_GBPS[l.max]}` : '', note, state };
  }
  const fmt = (g, w) => g ? `PCIe ${PCIE_GEN[g] || g} x${w || '?'}` : '';
  const text = fmt(l.cur, l.curWidth) || 'PCIe';
  let note = '', state = 'ok';
  if (l.curWidth && l.maxWidth && l.curWidth < l.maxWidth) {
    state = 'warn';
    note = `只用了 ${l.curWidth} 条通道（支持 ${l.maxWidth} 条），速度会变慢。请检查是否插在共享通道或较低速的 M.2 插槽。`;
  } else if (l.cur && l.max && l.cur < l.max) {
    state = 'info';
    note = `SSD 支持 PCIe ${PCIE_GEN[l.max]}，目前是 PCIe ${PCIE_GEN[l.cur]}。可能是主板插槽只支持较低版本，或 SSD 正处于省电状态（测速时再确认）。`;
  }
  return { text, max: fmt(l.max, l.maxWidth), note, state };
}

function clamp(v) { return Math.max(0, Math.min(100, Math.round(v))); }

function evaluate(disk) {
  const base = !disk.smartOk
    ? { health: null, status: 'unknown', reasons: [disk.error || '无法读取 SMART'], temperatureC: null, rows: [] }
    : disk.nvme ? evaluateNvme(disk) : evaluateAta(disk);
  base.link = linkInfo(disk);
  base.firmwareWarning = firmwareWarning(disk);
  base.kind = disk.rpm === 1 ? 'SSD' : disk.rpm > 1 ? `HDD ${disk.rpm} RPM` : '';
  return base;
}

module.exports = { evaluate, attrName, rawValue };
