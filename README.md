<p align="center"><img src="brand/smartDisk_horizontal.png" alt="smartDisk" width="320"></p>

# smartDisk

店内自用的硬盘健康检测工具（Windows）。

By PLANET COMPUTER TECHNOLOGY CENTRE, Batu Gajah, Perak. WhatsApp +60 12-510 5542, planet@planetctc.com.my.

## 结构

```
brand/             logo（alt_drive/ 是另一款硬盘外形的备选）
build/icon.ico     程序和安装包图标
helper/            原生检测程序（C++，需管理员权限）
  smartdisk-helper.cpp   枚举 PhysicalDrive0..31，读 SATA SMART / NVMe 健康日志，输出 JSON
  mock.json              非 Windows 或未编译 helper 时使用的演示数据
app/
  main.js          Electron 主进程：调用 helper，加上健康度判断，经 IPC 交给界面
  core/health.js   健康度规则（界面、以后的 PDF 报告、远程接口共用）
  renderer/        界面（多盘切换、健康度/温度、属性表、皮肤）
.github/workflows/build.yml   在 GitHub 的 Windows 机器上自动打包 Setup 安装程序
```

## 数据流

`smartdisk-helper.exe` → JSON → `main.js scanDisks()` → `health.evaluate()` → 界面

以后加 Tailscale 远程查看：在 `main.js` 里起一个只监听 Tailscale 网卡的 HTTP 服务，直接返回 `scanDisks()` 的结果。
PDF 报告：用 `BrowserWindow.webContents.printToPDF()` 打印一份报告页面即可。

## 本地开发（Windows）

需要：Node.js 20、Visual Studio 2022（含"使用 C++ 的桌面开发"）、CMake。

```
npm install
npm run build:helper     # 编译 helper
npm start                # 以管理员身份打开终端再运行，才读得到硬盘
npm run start:mock       # 用演示数据看界面
npm run dist             # 产出 dist/smartDisk-Setup-x.y.z.exe
```

## 已知限制

- USB 外接硬盘盒（JMicron / Realtek / ASMedia 等 SAT 桥接）多数读不到 SMART，第一版只显示提示。
- RAID / Intel RST 阵列模式下的硬盘可能无法直接读取。
- 安装包未做代码签名，首次运行 Windows SmartScreen 可能提示，选"仍要运行"即可。

版本记录见 [Ver.txt](Ver.txt)。

© 2026 PLANET COMPUTER TECHNOLOGY CENTRE. All rights reserved.
