// SmartDisk helper: enumerates physical disks and prints their health data as JSON.
// SATA: ATA pass-through SMART READ DATA / READ THRESHOLDS.
// NVMe: IOCTL_STORAGE_QUERY_PROPERTY, protocol-specific log page 0x02 (SMART / Health Information).
// Must run elevated (raw disk handles need administrator rights).
//
// Also reports the interface link (SATA 1.5/3/6 Gb/s via IDENTIFY, PCIe gen/lanes via the NVMe controller's devnode).
//
// Usage: smartdisk-helper.exe            -> JSON for all disks on stdout
//        smartdisk-helper.exe --pretty   -> same, indented
//        smartdisk-helper.exe bench X [MiB] / scan N  -> see disktests.cpp
//        smartdisk-helper.exe selftest N short|long|abort|status -> see selftest.cpp
//        smartdisk-helper.exe capacity X / erase N ERASE-N [auto|zero|nvme] -> see disktools.cpp

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <initguid.h>   // before winioctl.h so GUID_DEVINTERFACE_DISK and the DEVPROPKEYs below are defined here
#include <winioctl.h>
#include <ntddscsi.h>
#include <nvme.h>
#include <devpropdef.h>
#include <setupapi.h>
#include <cfgmgr32.h>
#pragma comment(lib, "setupapi.lib")
#pragma comment(lib, "cfgmgr32.lib")

// PCI Express link properties (same values as pciprop.h).
DEFINE_DEVPROPKEY(SD_PciCurrentLinkSpeed, 0x3ab22e31, 0x8264, 0x4b4e, 0x9a, 0xf5, 0xa8, 0xd2, 0xd8, 0xe3, 0x3e, 0x62, 9);
DEFINE_DEVPROPKEY(SD_PciCurrentLinkWidth, 0x3ab22e31, 0x8264, 0x4b4e, 0x9a, 0xf5, 0xa8, 0xd2, 0xd8, 0xe3, 0x3e, 0x62, 10);
DEFINE_DEVPROPKEY(SD_PciMaxLinkSpeed,     0x3ab22e31, 0x8264, 0x4b4e, 0x9a, 0xf5, 0xa8, 0xd2, 0xd8, 0xe3, 0x3e, 0x62, 11);
DEFINE_DEVPROPKEY(SD_PciMaxLinkWidth,     0x3ab22e31, 0x8264, 0x4b4e, 0x9a, 0xf5, 0xa8, 0xd2, 0xd8, 0xe3, 0x3e, 0x62, 12);

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
#include <sstream>
#include <memory>

// ---------- tiny JSON writer ----------
static std::string jsonEscape(const std::string& s) {
    std::string o;
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
                else o += (char)c;
        }
    }
    return o;
}

static std::string trim(std::string s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

// ---------- data model ----------
struct SmartAttr {
    int id; int flags; int current; int worst; int threshold; uint64_t raw;
};

struct NvmeHealth {
    int criticalWarning; int temperatureC; int availableSpare; int spareThreshold; int percentageUsed;
    uint64_t dataUnitsRead, dataUnitsWritten, hostReads, hostWrites, controllerBusyMin,
             powerCycles, powerOnHours, unsafeShutdowns, mediaErrors, errorLogEntries;
};

struct Disk {
    int index = 0;
    std::string model, serial, firmware, bus;   // bus: "sata" | "nvme" | "usb" | "other"
    std::vector<std::string> letters;           // drive letters on this disk, e.g. "C:"
    uint64_t sizeBytes = 0;
    bool smartOk = false;
    std::string error;
    std::vector<SmartAttr> attrs;
    bool hasNvme = false;
    NvmeHealth nvme{};
    // Interface link: SATA generation (1/2/3 = 1.5/3/6 Gb/s) or PCIe generation + lanes. 0 = unknown.
    int sataCur = 0, sataMax = 0;
    int pcieCur = 0, pcieCurWidth = 0, pcieMax = 0, pcieMaxWidth = 0;
    int rpm = 0;                                // 1 = SSD (non-rotating), >1 = RPM, 0 = unknown
    std::string bridge;                         // USB: how SMART was read (sat / asmedia / realtek / ata)
    unsigned usbVid = 0, usbPid = 0;
};

// ---------- helpers ----------
static std::string readStr(const BYTE* base, DWORD off, DWORD max) {
    if (!off || off >= max) return "";
    return trim(std::string((const char*)base + off));
}

static void queryDescriptor(HANDLE h, Disk& d, STORAGE_BUS_TYPE& busType) {
    STORAGE_PROPERTY_QUERY q{}; q.PropertyId = StorageDeviceProperty; q.QueryType = PropertyStandardQuery;
    std::vector<BYTE> buf(4096); DWORD ret = 0;
    busType = BusTypeUnknown;
    if (!DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, &q, sizeof(q), buf.data(), (DWORD)buf.size(), &ret, nullptr)) return;
    auto* desc = (STORAGE_DEVICE_DESCRIPTOR*)buf.data();
    std::string vendor = readStr(buf.data(), desc->VendorIdOffset, ret);
    std::string product = readStr(buf.data(), desc->ProductIdOffset, ret);
    d.model = trim(vendor.empty() ? product : vendor + " " + product);
    d.firmware = readStr(buf.data(), desc->ProductRevisionOffset, ret);
    d.serial = readStr(buf.data(), desc->SerialNumberOffset, ret);
    busType = desc->BusType;
    switch (busType) {
        case BusTypeSata: case BusTypeAta: d.bus = "sata"; break;
        case BusTypeNvme: d.bus = "nvme"; break;
        case BusTypeUsb:  d.bus = "usb"; break;
        default:          d.bus = "other"; break;
    }
}

static void querySize(HANDLE h, Disk& d) {
    GET_LENGTH_INFORMATION li{}; DWORD ret = 0;
    if (DeviceIoControl(h, IOCTL_DISK_GET_LENGTH_INFO, nullptr, 0, &li, sizeof(li), &ret, nullptr))
        d.sizeBytes = (uint64_t)li.Length.QuadPart;
}

// ---------- SATA SMART via ATA pass-through ----------
struct AtaBuf { ATA_PASS_THROUGH_EX apt; BYTE data[512]; };

static bool ataSmartCmd(HANDLE h, BYTE feature, BYTE out[512]) {
    AtaBuf b{};
    b.apt.Length = sizeof(ATA_PASS_THROUGH_EX);
    b.apt.AtaFlags = ATA_FLAGS_DATA_IN | ATA_FLAGS_DRDY_REQUIRED;
    b.apt.DataTransferLength = 512;
    b.apt.TimeOutValue = 5;
    b.apt.DataBufferOffset = offsetof(AtaBuf, data);
    b.apt.CurrentTaskFile[0] = feature; // 0xD0 READ DATA, 0xD1 READ THRESHOLDS
    b.apt.CurrentTaskFile[1] = 1;       // sector count
    b.apt.CurrentTaskFile[2] = 1;       // LBA low
    b.apt.CurrentTaskFile[3] = 0x4F;    // LBA mid  (SMART signature)
    b.apt.CurrentTaskFile[4] = 0xC2;    // LBA high (SMART signature)
    b.apt.CurrentTaskFile[5] = 0xA0;    // device
    b.apt.CurrentTaskFile[6] = 0xB0;    // command: SMART
    DWORD ret = 0;
    if (!DeviceIoControl(h, IOCTL_ATA_PASS_THROUGH, &b, sizeof(b), &b, sizeof(b), &ret, nullptr)) return false;
    if (b.apt.CurrentTaskFile[6] & 0x01) return false; // status register ERR bit
    memcpy(out, b.data, 512);
    return true;
}

// IDENTIFY DEVICE: SATA link speed (words 76/77) and rotation rate (word 217).
static void ataIdentify(HANDLE h, Disk& d) {
    AtaBuf b{};
    b.apt.Length = sizeof(ATA_PASS_THROUGH_EX);
    b.apt.AtaFlags = ATA_FLAGS_DATA_IN | ATA_FLAGS_DRDY_REQUIRED;
    b.apt.DataTransferLength = 512;
    b.apt.TimeOutValue = 5;
    b.apt.DataBufferOffset = offsetof(AtaBuf, data);
    b.apt.CurrentTaskFile[5] = 0xA0;
    b.apt.CurrentTaskFile[6] = 0xEC;    // IDENTIFY DEVICE
    DWORD ret = 0;
    if (!DeviceIoControl(h, IOCTL_ATA_PASS_THROUGH, &b, sizeof(b), &b, sizeof(b), &ret, nullptr)) return;
    if (b.apt.CurrentTaskFile[6] & 0x01) return;
    const WORD* w = (const WORD*)b.data;
    WORD w76 = w[76], w77 = w[77], w217 = w[217];
    if (w76 != 0 && w76 != 0xFFFF) {
        for (int g = 3; g >= 1; --g) if (w76 & (1 << g)) { d.sataMax = g; break; }
    }
    if (w77 != 0 && w77 != 0xFFFF) {
        int cur = (w77 >> 1) & 7;
        if (cur >= 1 && cur <= 3) d.sataCur = cur;
    }
    if (w217 == 1) d.rpm = 1;
    else if (w217 >= 0x0401 && w217 <= 0xFFFE) d.rpm = w217;
}

// Fallback for controllers that refuse ATA pass-through but support the legacy SMART IOCTL.
static bool legacySmartCmd(HANDLE h, BYTE feature, BYTE out[512]) {
    std::vector<BYTE> buf(sizeof(SENDCMDOUTPARAMS) + 512);
    SENDCMDINPARAMS in{};
    in.cBufferSize = 512;
    in.irDriveRegs.bFeaturesReg = feature;
    in.irDriveRegs.bSectorCountReg = 1;
    in.irDriveRegs.bSectorNumberReg = 1;
    in.irDriveRegs.bCylLowReg = 0x4F;
    in.irDriveRegs.bCylHighReg = 0xC2;
    in.irDriveRegs.bDriveHeadReg = 0xA0;
    in.irDriveRegs.bCommandReg = 0xB0;
    DWORD ret = 0;
    if (!DeviceIoControl(h, SMART_RCV_DRIVE_DATA, &in, sizeof(in) - 1, buf.data(), (DWORD)buf.size(), &ret, nullptr)) return false;
    memcpy(out, ((SENDCMDOUTPARAMS*)buf.data())->bBuffer, 512);
    return true;
}

static bool readSata(HANDLE h, Disk& d) {
    ataIdentify(h, d);
    BYTE values[512]{}, thresh[512]{};
    bool ok = ataSmartCmd(h, 0xD0, values) && ataSmartCmd(h, 0xD1, thresh);
    if (!ok) ok = legacySmartCmd(h, 0xD0, values) && legacySmartCmd(h, 0xD1, thresh);
    if (!ok) { d.error = "SMART read failed"; return false; }

    for (int i = 0; i < 30; ++i) {
        const BYTE* a = values + 2 + i * 12;
        if (a[0] == 0) continue;
        SmartAttr s{};
        s.id = a[0];
        s.flags = a[1] | (a[2] << 8);
        s.current = a[3];
        s.worst = a[4];
        s.raw = 0;
        for (int k = 5; k >= 0; --k) s.raw = (s.raw << 8) | a[5 + k];
        for (int j = 0; j < 30; ++j) {
            const BYTE* t = thresh + 2 + j * 12;
            if (t[0] == a[0]) { s.threshold = t[1]; break; }
        }
        d.attrs.push_back(s);
    }
    d.smartOk = !d.attrs.empty();
    return d.smartOk;
}

// ---------- NVMe Identify Controller (real serial / model / firmware) ----------
// StorageDeviceProperty often returns the EUI-64/NGUID instead of the serial number for NVMe drives.
static std::string fixedStr(const BYTE* p, size_t n) { return trim(std::string((const char*)p, n)); }

static void readNvmeIdentify(HANDLE h, Disk& d) {
    const DWORD idSize = 4096;
    const DWORD bufLen = FIELD_OFFSET(STORAGE_PROPERTY_QUERY, AdditionalParameters) + sizeof(STORAGE_PROTOCOL_SPECIFIC_DATA) + idSize;
    std::vector<BYTE> buf(bufLen);
    auto* q = (STORAGE_PROPERTY_QUERY*)buf.data();
    auto* p = (STORAGE_PROTOCOL_SPECIFIC_DATA*)q->AdditionalParameters;
    q->PropertyId = StorageAdapterProtocolSpecificProperty;
    q->QueryType = PropertyStandardQuery;
    p->ProtocolType = ProtocolTypeNvme;
    p->DataType = NVMeDataTypeIdentify;
    p->ProtocolDataRequestValue = NVME_IDENTIFY_CNS_CONTROLLER;
    p->ProtocolDataRequestSubValue = 0;
    p->ProtocolDataOffset = sizeof(STORAGE_PROTOCOL_SPECIFIC_DATA);
    p->ProtocolDataLength = idSize;
    DWORD ret = 0;
    if (!DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, buf.data(), bufLen, buf.data(), bufLen, &ret, nullptr)) return;
    auto* desc = (STORAGE_PROTOCOL_DATA_DESCRIPTOR*)buf.data();
    const BYTE* id = (const BYTE*)&desc->ProtocolSpecificData + desc->ProtocolSpecificData.ProtocolDataOffset;
    std::string sn = fixedStr(id + 4, 20), mn = fixedStr(id + 24, 40), fr = fixedStr(id + 64, 8);
    if (!sn.empty()) d.serial = sn;
    if (!mn.empty()) d.model = mn;
    if (!fr.empty()) d.firmware = fr;
}

// ---------- NVMe health log (page 0x02) ----------
static uint64_t le64(const BYTE* p) { uint64_t v = 0; for (int i = 7; i >= 0; --i) v = (v << 8) | p[i]; return v; }

static void parseNvmeLog(const BYTE* log, Disk& d);

static bool readNvme(HANDLE h, Disk& d) {
    const DWORD logSize = 512;
    const DWORD bufLen = FIELD_OFFSET(STORAGE_PROPERTY_QUERY, AdditionalParameters) + sizeof(STORAGE_PROTOCOL_SPECIFIC_DATA) + logSize;
    std::vector<BYTE> buf(bufLen);
    auto* q = (STORAGE_PROPERTY_QUERY*)buf.data();
    auto* p = (STORAGE_PROTOCOL_SPECIFIC_DATA*)q->AdditionalParameters;

    auto run = [&](STORAGE_PROPERTY_ID pid) {
        std::fill(buf.begin(), buf.end(), 0);
        q->PropertyId = pid;
        q->QueryType = PropertyStandardQuery;
        p->ProtocolType = ProtocolTypeNvme;
        p->DataType = NVMeDataTypeLogPage;
        p->ProtocolDataRequestValue = NVME_LOG_PAGE_HEALTH_INFO;
        p->ProtocolDataRequestSubValue = 0;
        p->ProtocolDataOffset = sizeof(STORAGE_PROTOCOL_SPECIFIC_DATA);
        p->ProtocolDataLength = logSize;
        DWORD ret = 0;
        return DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, buf.data(), bufLen, buf.data(), bufLen, &ret, nullptr) != 0;
    };
    if (!run(StorageDeviceProtocolSpecificProperty) && !run(StorageAdapterProtocolSpecificProperty)) {
        d.error = "NVMe health log read failed";
        return false;
    }

    auto* desc = (STORAGE_PROTOCOL_DATA_DESCRIPTOR*)buf.data();
    const BYTE* log = (const BYTE*)&desc->ProtocolSpecificData + desc->ProtocolSpecificData.ProtocolDataOffset;
    parseNvmeLog(log, d);
    return true;
}

static void parseNvmeLog(const BYTE* log, Disk& d) {
    NvmeHealth& n = d.nvme;
    n.criticalWarning   = log[0];
    n.temperatureC      = (int)(log[1] | (log[2] << 8)) - 273;
    n.availableSpare    = log[3];
    n.spareThreshold    = log[4];
    n.percentageUsed    = log[5];
    n.dataUnitsRead     = le64(log + 32);   // 128-bit counters; low 64 bits are plenty
    n.dataUnitsWritten  = le64(log + 48);
    n.hostReads         = le64(log + 64);
    n.hostWrites        = le64(log + 80);
    n.controllerBusyMin = le64(log + 96);
    n.powerCycles       = le64(log + 112);
    n.powerOnHours      = le64(log + 128);
    n.unsafeShutdowns   = le64(log + 144);
    n.mediaErrors       = le64(log + 160);
    n.errorLogEntries   = le64(log + 176);
    d.hasNvme = d.smartOk = true;
}

// ---------- PCIe link of the controller each disk hangs off (NVMe) ----------
static ULONG devUlong(DEVINST inst, const DEVPROPKEY& key) {
    DEVPROPTYPE type = 0; ULONG val = 0, size = sizeof(val);
    if (CM_Get_DevNode_PropertyW(inst, &key, &type, (PBYTE)&val, &size, 0) != CR_SUCCESS || type != DEVPROP_TYPE_UINT32) return 0;
    return val;
}

static void assignPcieLinks(std::vector<Disk>& disks) {
    HDEVINFO set = SetupDiGetClassDevsW(&GUID_DEVINTERFACE_DISK, nullptr, nullptr, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (set == INVALID_HANDLE_VALUE) return;
    SP_DEVICE_INTERFACE_DATA ifd{ sizeof(ifd) };
    for (DWORD i = 0; SetupDiEnumDeviceInterfaces(set, nullptr, &GUID_DEVINTERFACE_DISK, i, &ifd); ++i) {
        DWORD need = 0;
        SetupDiGetDeviceInterfaceDetailW(set, &ifd, nullptr, 0, &need, nullptr);
        if (!need) continue;
        std::vector<BYTE> detailBuf(need);
        auto* detail = (SP_DEVICE_INTERFACE_DETAIL_DATA_W*)detailBuf.data();
        detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
        SP_DEVINFO_DATA dev{ sizeof(dev) };
        if (!SetupDiGetDeviceInterfaceDetailW(set, &ifd, detail, need, nullptr, &dev)) continue;
        HANDLE h = CreateFileW(detail->DevicePath, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h == INVALID_HANDLE_VALUE) continue;
        STORAGE_DEVICE_NUMBER sdn{}; DWORD ret = 0;
        BOOL ok = DeviceIoControl(h, IOCTL_STORAGE_GET_DEVICE_NUMBER, nullptr, 0, &sdn, sizeof(sdn), &ret, nullptr);
        CloseHandle(h);
        if (!ok) continue;
        DEVINST parent = 0;
        if (CM_Get_Parent(&parent, dev.DevInst, 0) != CR_SUCCESS) continue;
        for (auto& d : disks) {
            if (d.index != (int)sdn.DeviceNumber || d.bus != "nvme") continue;
            d.pcieCur = (int)devUlong(parent, SD_PciCurrentLinkSpeed);
            d.pcieCurWidth = (int)devUlong(parent, SD_PciCurrentLinkWidth);
            d.pcieMax = (int)devUlong(parent, SD_PciMaxLinkSpeed);
            d.pcieMaxWidth = (int)devUlong(parent, SD_PciMaxLinkWidth);
            d.rpm = 1;
        }
    }
    SetupDiDestroyDeviceInfoList(set);
}

// ---------- drive letters ----------
// Map each mounted letter to its physical disk number (volumes spanning several disks are skipped).
static void assignLetters(std::vector<Disk>& disks) {
    DWORD mask = GetLogicalDrives();
    for (int i = 0; i < 26; ++i) {
        if (!(mask & (1u << i))) continue;
        wchar_t root[] = { wchar_t(L'A' + i), L':', L'\\', 0 };
        UINT type = GetDriveTypeW(root);
        if (type != DRIVE_FIXED && type != DRIVE_REMOVABLE) continue;
        wchar_t vol[] = { L'\\', L'\\', L'.', L'\\', wchar_t(L'A' + i), L':', 0 };
        HANDLE h = CreateFileW(vol, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h == INVALID_HANDLE_VALUE) continue;
        STORAGE_DEVICE_NUMBER sdn{}; DWORD ret = 0;
        if (DeviceIoControl(h, IOCTL_STORAGE_GET_DEVICE_NUMBER, nullptr, 0, &sdn, sizeof(sdn), &ret, nullptr)) {
            for (auto& d : disks)
                if (d.index == (int)sdn.DeviceNumber) d.letters.push_back(std::string(1, char('A' + i)) + ":");
        }
        CloseHandle(h);
    }
}

// ---------- USB enclosures ----------
// SATA in a USB box: standard SCSI/ATA Translation (ATA PASS-THROUGH 12/16), supported by most bridges
// (JMicron JMS567/578, ASMedia ASM1051/1153/235CM, Realtek, VIA...).
// NVMe in a USB box: vendor commands, only sent to bridges recognised by their USB vendor ID
// (ASMedia ASM2362/2364: E6h, Realtek RTL9210/9211: E4h), the same commands smartmontools uses.
struct SptBuf { SCSI_PASS_THROUGH spt; BYTE sense[32]; BYTE data[4096]; };

static bool scsiIn(HANDLE h, const BYTE* cdb, int cdbLen, BYTE* out, DWORD len) {
    auto b = std::make_unique<SptBuf>();
    ZeroMemory(b.get(), sizeof(SptBuf));
    b->spt.Length = sizeof(SCSI_PASS_THROUGH);
    b->spt.CdbLength = (UCHAR)cdbLen;
    b->spt.SenseInfoLength = sizeof(b->sense);
    b->spt.SenseInfoOffset = offsetof(SptBuf, sense);
    b->spt.DataIn = SCSI_IOCTL_DATA_IN;
    b->spt.DataTransferLength = len;
    b->spt.DataBufferOffset = offsetof(SptBuf, data);
    b->spt.TimeOutValue = 10;
    memcpy(b->spt.Cdb, cdb, cdbLen);
    DWORD ret = 0;
    if (!DeviceIoControl(h, IOCTL_SCSI_PASS_THROUGH, b.get(), sizeof(SptBuf), b.get(), sizeof(SptBuf), &ret, nullptr)) return false;
    if (b->spt.ScsiStatus != 0) return false;
    memcpy(out, b->data, len);
    return true;
}

// One PIO data-in ATA command (512 bytes) through SAT: try the 12-byte CDB, then the 16-byte one.
static bool satIn(HANDLE h, BYTE feature, BYTE lbaLow, BYTE lbaMid, BYTE lbaHigh, BYTE command, BYTE out[512]) {
    BYTE c12[12] = { 0xA1, 4 << 1, 0x0E, feature, 1, lbaLow, lbaMid, lbaHigh, 0xA0, command, 0, 0 };
    if (scsiIn(h, c12, 12, out, 512)) return true;
    BYTE c16[16] = { 0x85, 4 << 1, 0x0E, 0, feature, 0, 1, 0, lbaLow, 0, lbaMid, 0, lbaHigh, 0xA0, command, 0 };
    return scsiIn(h, c16, 16, out, 512);
}

static std::string ataStr(const BYTE* id, int firstWord, int words) {
    std::string s;
    for (int i = 0; i < words; ++i) { s += (char)id[(firstWord + i) * 2 + 1]; s += (char)id[(firstWord + i) * 2]; }
    for (char& c : s) if ((unsigned char)c < 0x20 || (unsigned char)c > 0x7E) c = ' ';
    return trim(s);
}

static bool readUsbSata(HANDLE h, Disk& d) {
    BYTE id[512]{};
    if (!satIn(h, 0, 0, 0, 0, 0xEC, id)) return false;
    const WORD* w = (const WORD*)id;
    std::string model = ataStr(id, 27, 20);
    if ((w[0] & 0x8000) || model.empty()) return false;   // not an ATA device / garbage
    d.model = model;
    std::string sn = ataStr(id, 10, 10), fw = ataStr(id, 23, 4);
    if (!sn.empty()) d.serial = sn;
    if (!fw.empty()) d.firmware = fw;
    if (w[217] == 1) d.rpm = 1; else if (w[217] >= 0x0401 && w[217] <= 0xFFFE) d.rpm = w[217];
    BYTE values[512]{}, thresh[512]{};
    if (!satIn(h, 0xD0, 0, 0x4F, 0xC2, 0xB0, values)) { d.error = "USB bridge: SMART read failed"; return true; }
    satIn(h, 0xD1, 0, 0x4F, 0xC2, 0xB0, thresh);
    for (int i = 0; i < 30; ++i) {
        const BYTE* a = values + 2 + i * 12;
        if (a[0] == 0) continue;
        SmartAttr s{};
        s.id = a[0]; s.flags = a[1] | (a[2] << 8); s.current = a[3]; s.worst = a[4]; s.raw = 0;
        for (int k = 5; k >= 0; --k) s.raw = (s.raw << 8) | a[5 + k];
        for (int j = 0; j < 30; ++j) { const BYTE* t = thresh + 2 + j * 12; if (t[0] == a[0]) { s.threshold = t[1]; break; } }
        d.attrs.push_back(s);
    }
    d.smartOk = !d.attrs.empty();
    d.bridge = "sat";
    return true;
}

// USB vendor / product ID of the bridge a disk sits behind (0 when not found).
static void usbIds(int diskIndex, unsigned& vid, unsigned& pid) {
    vid = pid = 0;
    HDEVINFO set = SetupDiGetClassDevsW(&GUID_DEVINTERFACE_DISK, nullptr, nullptr, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (set == INVALID_HANDLE_VALUE) return;
    SP_DEVICE_INTERFACE_DATA ifd{ sizeof(ifd) };
    for (DWORD i = 0; SetupDiEnumDeviceInterfaces(set, nullptr, &GUID_DEVINTERFACE_DISK, i, &ifd) && !vid; ++i) {
        DWORD need = 0;
        SetupDiGetDeviceInterfaceDetailW(set, &ifd, nullptr, 0, &need, nullptr);
        if (!need) continue;
        std::vector<BYTE> detailBuf(need);
        auto* detail = (SP_DEVICE_INTERFACE_DETAIL_DATA_W*)detailBuf.data();
        detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
        SP_DEVINFO_DATA dev{ sizeof(dev) };
        if (!SetupDiGetDeviceInterfaceDetailW(set, &ifd, detail, need, nullptr, &dev)) continue;
        HANDLE h = CreateFileW(detail->DevicePath, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h == INVALID_HANDLE_VALUE) continue;
        STORAGE_DEVICE_NUMBER sdn{}; DWORD ret = 0;
        BOOL ok = DeviceIoControl(h, IOCTL_STORAGE_GET_DEVICE_NUMBER, nullptr, 0, &sdn, sizeof(sdn), &ret, nullptr);
        CloseHandle(h);
        if (!ok || (int)sdn.DeviceNumber != diskIndex) continue;
        DEVINST inst = dev.DevInst;
        for (int depth = 0; depth < 6; ++depth) {
            wchar_t idBuf[MAX_DEVICE_ID_LEN]{};
            if (CM_Get_Device_IDW(inst, idBuf, MAX_DEVICE_ID_LEN, 0) == CR_SUCCESS) {
                std::wstring sid(idBuf);
                size_t v = sid.find(L"VID_"), p = sid.find(L"PID_");
                if (sid.rfind(L"USB\\", 0) == 0 && v != std::wstring::npos && p != std::wstring::npos) {
                    vid = wcstoul(sid.substr(v + 4, 4).c_str(), nullptr, 16);
                    pid = wcstoul(sid.substr(p + 4, 4).c_str(), nullptr, 16);
                    break;
                }
            }
            DEVINST parent = 0;
            if (CM_Get_Parent(&parent, inst, 0) != CR_SUCCESS) break;
            inst = parent;
        }
    }
    SetupDiDestroyDeviceInfoList(set);
}

// NVMe admin Identify / Get Log Page through a vendor USB bridge. kind: 'a' ASMedia, 'r' Realtek.
static bool usbNvmeIn(HANDLE h, char kind, BYTE opcode, DWORD cdw10, BYTE* out, DWORD len) {
    BYTE cdb[16]{};
    if (kind == 'a') {
        cdb[0] = 0xE6; cdb[1] = opcode; cdb[3] = (BYTE)cdw10; cdb[7] = (BYTE)(cdw10 >> 16);
    } else {
        cdb[0] = 0xE4; cdb[1] = (BYTE)len; cdb[2] = (BYTE)(len >> 8); cdb[3] = opcode; cdb[4] = (BYTE)cdw10;
    }
    return scsiIn(h, cdb, 16, out, len);
}

static bool readUsbNvme(HANDLE h, unsigned vid, Disk& d) {
    char kind = vid == 0x174C ? 'a' : vid == 0x0BDA ? 'r' : 0;
    if (!kind) return false;
    std::vector<BYTE> id(4096);
    if (!usbNvmeIn(h, kind, 0x06, 1, id.data(), 4096)) return false;   // Identify Controller
    std::string mn = fixedStr(id.data() + 24, 40);
    if ((id[0] | id[1]) == 0 || mn.empty()) return false;
    for (char c : mn) if ((unsigned char)c < 0x20 || (unsigned char)c > 0x7E) return false;
    d.model = mn;
    std::string sn = fixedStr(id.data() + 4, 20), fr = fixedStr(id.data() + 64, 8);
    if (!sn.empty()) d.serial = sn;
    if (!fr.empty()) d.firmware = fr;
    BYTE log[512]{};
    // Get Log Page 02h (SMART / Health), 512 bytes: NUMDL = 127.
    if (!usbNvmeIn(h, kind, 0x02, (127u << 16) | 0x02, log, 512)) { d.error = "USB bridge: NVMe health log read failed"; return true; }
    parseNvmeLog(log, d);
    d.rpm = 1;
    d.bridge = kind == 'a' ? "asmedia" : "realtek";
    return true;
}

static void readUsb(HANDLE h, Disk& d) {
    unsigned vid = 0, pid = 0;
    usbIds(d.index, vid, pid);
    d.usbVid = vid; d.usbPid = pid;
    if (readUsbSata(h, d)) return;
    if (readUsbNvme(h, vid, d)) return;
    // Last resort: some bridges accept the plain ATA pass-through IOCTL.
    if (readSata(h, d)) { d.bridge = "ata"; return; }
    d.error = vid == 0x152D ? "USB bridge: JMicron NVMe bridge, SMART not supported" : "USB bridge: SMART not supported";
}

// ---------- output ----------
static void writeDisk(std::ostringstream& o, const Disk& d, const char* ind) {
    o << ind << "{\"index\":" << d.index
      << ",\"model\":\"" << jsonEscape(d.model) << "\""
      << ",\"serial\":\"" << jsonEscape(d.serial) << "\""
      << ",\"firmware\":\"" << jsonEscape(d.firmware) << "\""
      << ",\"bus\":\"" << d.bus << "\""
      << ",\"sizeBytes\":" << d.sizeBytes;
    o << ",\"letters\":[";
    for (size_t i = 0; i < d.letters.size(); ++i) o << (i ? "," : "") << "\"" << d.letters[i] << "\"";
    o << "]";
    o << ",\"rpm\":" << d.rpm;
    if (!d.bridge.empty()) o << ",\"bridge\":\"" << d.bridge << "\"";
    if (d.usbVid) { char ids[32]; sprintf_s(ids, "%04X:%04X", d.usbVid, d.usbPid); o << ",\"usbId\":\"" << ids << "\""; }
    if (d.sataMax || d.sataCur) o << ",\"link\":{\"kind\":\"sata\",\"cur\":" << d.sataCur << ",\"max\":" << d.sataMax << "}";
    else if (d.pcieCur || d.pcieMax)
        o << ",\"link\":{\"kind\":\"pcie\",\"cur\":" << d.pcieCur << ",\"curWidth\":" << d.pcieCurWidth
          << ",\"max\":" << d.pcieMax << ",\"maxWidth\":" << d.pcieMaxWidth << "}";
    o << ",\"smartOk\":" << (d.smartOk ? "true" : "false");
    if (!d.error.empty()) o << ",\"error\":\"" << jsonEscape(d.error) << "\"";
    if (!d.attrs.empty()) {
        o << ",\"ata\":{\"attributes\":[";
        for (size_t i = 0; i < d.attrs.size(); ++i) {
            const auto& a = d.attrs[i];
            o << (i ? "," : "") << "{\"id\":" << a.id << ",\"flags\":" << a.flags << ",\"current\":" << a.current
              << ",\"worst\":" << a.worst << ",\"threshold\":" << a.threshold << ",\"raw\":" << a.raw << "}";
        }
        o << "]}";
    }
    if (d.hasNvme) {
        const auto& n = d.nvme;
        o << ",\"nvme\":{\"criticalWarning\":" << n.criticalWarning << ",\"temperatureC\":" << n.temperatureC
          << ",\"availableSpare\":" << n.availableSpare << ",\"spareThreshold\":" << n.spareThreshold
          << ",\"percentageUsed\":" << n.percentageUsed << ",\"dataUnitsRead\":" << n.dataUnitsRead
          << ",\"dataUnitsWritten\":" << n.dataUnitsWritten << ",\"hostReads\":" << n.hostReads
          << ",\"hostWrites\":" << n.hostWrites << ",\"controllerBusyMinutes\":" << n.controllerBusyMin
          << ",\"powerCycles\":" << n.powerCycles << ",\"powerOnHours\":" << n.powerOnHours
          << ",\"unsafeShutdowns\":" << n.unsafeShutdowns << ",\"mediaErrors\":" << n.mediaErrors
          << ",\"errorLogEntries\":" << n.errorLogEntries << "}";
    }
    o << "}";
}

int runBench(int argc, char** argv);   // disktests.cpp
int runScan(int argc, char** argv);
int runSelfTest(int argc, char** argv);   // selftest.cpp
int runCapacity(int argc, char** argv);   // disktools.cpp
int runErase(int argc, char** argv);
int runStress(int argc, char** argv);   // stress.cpp
int runMemTest(int argc, char** argv);  // memtest.cpp

int main(int argc, char** argv) {
    if (argc > 1 && std::string(argv[1]) == "bench") return runBench(argc, argv);
    if (argc > 1 && std::string(argv[1]) == "scan") return runScan(argc, argv);
    if (argc > 1 && std::string(argv[1]) == "selftest") return runSelfTest(argc, argv);
    if (argc > 1 && std::string(argv[1]) == "capacity") return runCapacity(argc, argv);
    if (argc > 1 && std::string(argv[1]) == "erase") return runErase(argc, argv);
    if (argc > 1 && std::string(argv[1]) == "stress") return runStress(argc, argv);
    if (argc > 1 && std::string(argv[1]) == "memtest") return runMemTest(argc, argv);
    bool pretty = argc > 1 && std::string(argv[1]) == "--pretty";
    std::vector<Disk> disks;
    bool anyAccessDenied = false;

    for (int i = 0; i < 32; ++i) {
        wchar_t path[64]; swprintf_s(path, L"\\\\.\\PhysicalDrive%d", i);
        HANDLE h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               nullptr, OPEN_EXISTING, 0, nullptr);
        if (h == INVALID_HANDLE_VALUE) {
            if (GetLastError() == ERROR_ACCESS_DENIED) anyAccessDenied = true;
            continue;
        }
        Disk d; d.index = i;
        STORAGE_BUS_TYPE bus;
        queryDescriptor(h, d, bus);
        querySize(h, d);
        if (d.bus == "nvme") { readNvmeIdentify(h, d); readNvme(h, d); }
        else if (d.bus == "usb") readUsb(h, d);
        else readSata(h, d);
        CloseHandle(h);
        disks.push_back(d);
    }

    assignLetters(disks);
    assignPcieLinks(disks);

    std::ostringstream o;
    const char* nl = pretty ? "\n" : "";
    const char* ind = pretty ? "    " : "";
    o << "{\"version\":1,\"elevated\":" << (anyAccessDenied ? "false" : "true") << ",\"disks\":[" << nl;
    for (size_t i = 0; i < disks.size(); ++i) {
        writeDisk(o, disks[i], ind);
        o << (i + 1 < disks.size() ? "," : "") << nl;
    }
    o << "]}" << "\n";
    fputs(o.str().c_str(), stdout);
    return anyAccessDenied && disks.empty() ? 2 : 0;
}
