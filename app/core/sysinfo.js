// Whole-PC information for the shop's "出机检测" report: CPU, RAM, GPU, board, Windows activation, battery.
// Uses PowerShell CIM queries (no admin needed). Returns null fields when something can't be read.
const { execFile } = require('child_process');
const { L } = require('../renderer/i18n');

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
function One($cls, $ns) { if ($ns) { Get-CimInstance -Namespace $ns -ClassName $cls } else { Get-CimInstance -ClassName $cls } }
$cs   = One Win32_ComputerSystem
$os   = One Win32_OperatingSystem
$bb   = One Win32_BaseBoard
$bios = One Win32_BIOS
$cpu  = @(One Win32_Processor)
$mem  = @(One Win32_PhysicalMemory)
$gpu  = @(One Win32_VideoController)
$lic  = Get-CimInstance -ClassName SoftwareLicensingProduct -Filter "ApplicationID='55c92734-d682-4d71-983e-d6ec3f16059f' AND PartialProductKey IS NOT NULL" | Select-Object -First 1
$bat  = @(One Win32_Battery)
$full = @(One BatteryFullChargedCapacity 'root\wmi')
$dsgn = @(One BatteryStaticData 'root\wmi')
[pscustomobject]@{
  computer = [pscustomobject]@{ manufacturer = $cs.Manufacturer; model = $cs.Model; name = $cs.Name }
  os = [pscustomobject]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; arch = $os.OSArchitecture }
  board = [pscustomobject]@{ manufacturer = $bb.Manufacturer; product = $bb.Product; bios = $bios.SMBIOSBIOSVersion; biosDate = if ($bios.ReleaseDate) { $bios.ReleaseDate.ToString('yyyy-MM-dd') } else { $null } }
  cpu = @($cpu | ForEach-Object { [pscustomobject]@{ name = $_.Name.Trim(); cores = $_.NumberOfCores; threads = $_.NumberOfLogicalProcessors; mhz = $_.MaxClockSpeed } })
  memory = @($mem | ForEach-Object { [pscustomobject]@{ slot = $_.DeviceLocator; bytes = [uint64]$_.Capacity; mhz = $_.ConfiguredClockSpeed; maker = $_.Manufacturer; part = ($_.PartNumber -as [string]).Trim() } })
  gpu = @($gpu | ForEach-Object { [pscustomobject]@{ name = $_.Name; driver = $_.DriverVersion } })
  activation = if ($lic) { [pscustomobject]@{ status = [int]$lic.LicenseStatus; name = $lic.Name; channel = $lic.ProductKeyChannel } } else { $null }
  battery = if ($bat.Count -gt 0) { [pscustomobject]@{ design = ($dsgn | Measure-Object DesignedCapacity -Sum).Sum; full = ($full | Measure-Object FullChargedCapacity -Sum).Sum; charge = $bat[0].EstimatedChargeRemaining } } else { $null }
} | ConvertTo-Json -Depth 5 -Compress
`;

const MOCK = {
  computer: { manufacturer: 'PLANET', model: 'Gaming PC', name: 'PLANET-PC-0123' },
  os: { caption: 'Microsoft Windows 11 Pro', version: '10.0.26100', build: '26100', arch: '64-bit' },
  board: { manufacturer: 'ASUSTeK COMPUTER INC.', product: 'TUF GAMING B760M-PLUS WIFI', bios: '1820', biosDate: '2025-08-12' },
  cpu: [{ name: 'Intel(R) Core(TM) i5-14400F', cores: 10, threads: 16, mhz: 2500 }],
  memory: [
    { slot: 'DIMM_A2', bytes: 17179869184, mhz: 5600, maker: 'Kingston', part: 'KF556C40-16' },
    { slot: 'DIMM_B2', bytes: 17179869184, mhz: 5600, maker: 'Kingston', part: 'KF556C40-16' },
  ],
  gpu: [{ name: 'NVIDIA GeForce RTX 4060', driver: '32.0.15.6614' }],
  activation: { status: 1, name: 'Windows(R), Professional edition', channel: 'Retail' },
  battery: null,
};

// LicenseStatus values from SoftwareLicensingProduct.
const LICENSE = () => L({ 0: '未授权', 1: '已激活', 2: '宽限期', 3: '宽限期', 4: '非正版宽限期', 5: '需要激活', 6: '宽限期' },
  { 0: 'Unlicensed', 1: 'Activated', 2: 'Grace period', 3: 'Grace period', 4: 'Non-genuine grace', 5: 'Needs activation', 6: 'Grace period' });

function summarize(s) {
  const gb = b => Math.round(b / 1073741824);
  const totalMem = (s.memory || []).reduce((a, m) => a + (m.bytes || 0), 0);
  const act = s.activation;
  const bat = s.battery && s.battery.design && s.battery.full
    ? { wear: Math.max(0, Math.round((1 - s.battery.full / s.battery.design) * 100)), design: s.battery.design, full: s.battery.full }
    : null;
  return {
    ...s,
    memTotalGB: totalMem ? gb(totalMem) : null,
    memText: (s.memory || []).map(m => `${gb(m.bytes)} GB ${m.mhz ? m.mhz + ' MHz' : ''} ${m.maker || ''} ${m.part || ''}`.replace(/\s+/g, ' ').trim()),
    activationText: act ? (LICENSE()[act.status] || L('未知', 'Unknown')) : L('无法读取', 'Unavailable'),
    activated: act ? act.status === 1 : null,
    batteryInfo: bat,
  };
}

function readSystemInfo({ mock } = {}) {
  if (mock || process.platform !== 'win32') return Promise.resolve(summarize(MOCK));
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        try {
          const s = JSON.parse(stdout);
          for (const k of ['cpu', 'memory', 'gpu']) if (s[k] && !Array.isArray(s[k])) s[k] = [s[k]];
          resolve(summarize(s));
        } catch (e) {
          resolve({ error: String(err || e) });
        }
      });
  });
}

module.exports = { readSystemInfo };
