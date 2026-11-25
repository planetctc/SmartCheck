// smartDisk helper: SMART self-test (the drive tests itself; nothing is written to user data).
//
//   smartdisk-helper.exe selftest <diskIndex> short|long|abort   -> start (or stop) a test, prints one JSON line
//   smartdisk-helper.exe selftest <diskIndex> status             -> progress and the latest result, one JSON line
//
// The test runs inside the drive, so the helper exits right away; the app polls "status".
// SATA: SMART EXECUTE OFF-LINE IMMEDIATE (B0h/D4h), progress from SMART data byte 363, result from the self-test log (06h).
// NVMe: Device Self-test (admin 14h) through IOCTL_STORAGE_PROTOCOL_COMMAND, falling back to SCSI SEND DIAGNOSTIC
//       (stornvme translates it); progress and results from the Device Self-test log page (06h).

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winioctl.h>
#include <ntddscsi.h>
#include <nvme.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <initializer_list>
#include <string>
#include <vector>

namespace {

void out(const std::string& s) { fputs(s.c_str(), stdout); fputc('\n', stdout); fflush(stdout); }
std::string err(const char* code, DWORD win = 0) {
    char b[160]; sprintf_s(b, "{\"ok\":false,\"error\":\"%s\",\"win32\":%lu}", code, win); return b;
}

// ---------- SATA ----------
struct AtaCmd { ATA_PASS_THROUGH_EX apt; BYTE data[512]; };

bool ataSmart(HANDLE h, BYTE feature, BYTE lbaLow, bool dataIn, BYTE* out512) {
    AtaCmd b{};
    b.apt.Length = sizeof(ATA_PASS_THROUGH_EX);
    b.apt.AtaFlags = ATA_FLAGS_DRDY_REQUIRED | (dataIn ? ATA_FLAGS_DATA_IN : 0);
    b.apt.DataTransferLength = dataIn ? 512 : 0;
    b.apt.TimeOutValue = 10;
    b.apt.DataBufferOffset = dataIn ? offsetof(AtaCmd, data) : 0;
    b.apt.CurrentTaskFile[0] = feature;
    b.apt.CurrentTaskFile[1] = 1;
    b.apt.CurrentTaskFile[2] = lbaLow;
    b.apt.CurrentTaskFile[3] = 0x4F;
    b.apt.CurrentTaskFile[4] = 0xC2;
    b.apt.CurrentTaskFile[5] = 0xA0;
    b.apt.CurrentTaskFile[6] = 0xB0;
    DWORD ret = 0;
    if (!DeviceIoControl(h, IOCTL_ATA_PASS_THROUGH, &b, sizeof(b), &b, sizeof(b), &ret, nullptr)) return false;
    if (b.apt.CurrentTaskFile[6] & 0x01) return false;
    if (dataIn && out512) memcpy(out512, b.data, 512);
    return true;
}

// SMART self-test status nibble (ATA ACS "self-test execution status").
const char* ataResult(int st) {
    switch (st) {
        case 0: return "passed";
        case 1: return "aborted";       // by host
        case 2: return "interrupted";   // by reset
        case 3: return "fatal";
        case 4: return "failed";        // unknown element
        case 5: return "failed_electrical";
        case 6: return "failed_servo";
        case 7: return "failed_read";
        case 8: return "failed_handling";
        case 15: return "running";
        default: return "unknown";
    }
}

int sataStatus(HANDLE h) {
    BYTE d[512]{};
    if (!ataSmart(h, 0xD0, 1, true, d)) { out(err("smart_read", GetLastError())); return 1; }
    int exec = d[363], st = exec >> 4, remain = (exec & 0x0F) * 10;
    int shortMin = d[372], longMin = d[373];
    if (longMin == 0xFF) longMin = d[375] | (d[376] << 8);
    std::string o = "{\"ok\":true,\"kind\":\"sata\",\"running\":" + std::string(st == 15 ? "true" : "false") +
        ",\"progress\":" + std::to_string(st == 15 ? 100 - remain : 100) +
        ",\"shortMin\":" + std::to_string(shortMin) + ",\"longMin\":" + std::to_string(longMin);
    // Latest finished entry of the SMART self-test log (log address 06h).
    BYTE lg[512]{};
    if (ataSmart(h, 0xD5, 0x06, true, lg)) {
        int idx = lg[508];
        if (idx >= 1 && idx <= 21) {
            const BYTE* e = lg + 2 + (idx - 1) * 24;
            int type = e[0], est = e[1] >> 4;
            unsigned hours = e[2] | (e[3] << 8);
            uint32_t lba = e[5] | (e[6] << 8) | (e[7] << 16) | ((uint32_t)e[8] << 24);
            const char* t = (type == 1 || type == 0x81) ? "short" : (type == 2 || type == 0x82) ? "long" : "other";
            o += ",\"last\":{\"type\":\"" + std::string(t) + "\",\"result\":\"" + ataResult(est) + "\",\"code\":" + std::to_string(est) +
                 ",\"hours\":" + std::to_string(hours);
            if (est >= 3 && est <= 8 && lba != 0xFFFFFFFF) o += ",\"lba\":" + std::to_string(lba);
            o += "}";
        }
    } else if (st != 15) {
        o += ",\"last\":{\"type\":\"other\",\"result\":\"" + std::string(ataResult(st)) + "\",\"code\":" + std::to_string(st) + "}";
    }
    out(o + "}");
    return 0;
}

int sataStart(HANDLE h, const std::string& what) {
    BYTE sub = what == "short" ? 0x01 : what == "long" ? 0x02 : 0x7F;
    if (!ataSmart(h, 0xD4, sub, false, nullptr)) { out(err("start_failed", GetLastError())); return 1; }
    out("{\"ok\":true,\"kind\":\"sata\",\"started\":\"" + what + "\"}");
    return 0;
}

// ---------- NVMe ----------
bool nvmeQuery(HANDLE h, STORAGE_PROTOCOL_NVME_DATA_TYPE type, DWORD value, std::vector<BYTE>& data, DWORD len) {
    const DWORD bufLen = FIELD_OFFSET(STORAGE_PROPERTY_QUERY, AdditionalParameters) + sizeof(STORAGE_PROTOCOL_SPECIFIC_DATA) + len;
    std::vector<BYTE> buf(bufLen);
    for (STORAGE_PROPERTY_ID pid : { StorageDeviceProtocolSpecificProperty, StorageAdapterProtocolSpecificProperty }) {
        std::fill(buf.begin(), buf.end(), 0);
        auto* q = (STORAGE_PROPERTY_QUERY*)buf.data();
        auto* p = (STORAGE_PROTOCOL_SPECIFIC_DATA*)q->AdditionalParameters;
        q->PropertyId = pid; q->QueryType = PropertyStandardQuery;
        p->ProtocolType = ProtocolTypeNvme; p->DataType = type;
        p->ProtocolDataRequestValue = value; p->ProtocolDataRequestSubValue = 0;
        p->ProtocolDataOffset = sizeof(STORAGE_PROTOCOL_SPECIFIC_DATA); p->ProtocolDataLength = len;
        DWORD ret = 0;
        if (!DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, buf.data(), bufLen, buf.data(), bufLen, &ret, nullptr)) continue;
        auto* desc = (STORAGE_PROTOCOL_DATA_DESCRIPTOR*)buf.data();
        const BYTE* d = (const BYTE*)&desc->ProtocolSpecificData + desc->ProtocolSpecificData.ProtocolDataOffset;
        data.assign(d, d + len);
        return true;
    }
    return false;
}

const char* nvmeResult(int st) {
    switch (st) {
        case 0: return "passed";
        case 1: case 2: case 3: case 4: case 8: case 9: return "aborted";
        case 5: return "fatal";
        case 6: case 7: return "failed";
        default: return "unknown";
    }
}

int nvmeStatus(HANDLE h) {
    std::vector<BYTE> lg, id;
    if (!nvmeQuery(h, NVMeDataTypeLogPage, 0x06, lg, 564)) { out(err("log_unsupported", GetLastError())); return 1; }
    int longMin = 0;
    if (nvmeQuery(h, NVMeDataTypeIdentify, NVME_IDENTIFY_CNS_CONTROLLER, id, 4096)) longMin = id[316] | (id[317] << 8);
    int op = lg[0] & 0x0F, pct = lg[1] & 0x7F;
    std::string o = "{\"ok\":true,\"kind\":\"nvme\",\"running\":" + std::string(op ? "true" : "false") +
        ",\"progress\":" + std::to_string(op ? pct : 100) + ",\"shortMin\":2,\"longMin\":" + std::to_string(longMin);
    // Newest result is the first 28-byte entry at offset 4; result 0Fh means the entry is unused.
    const BYTE* e = lg.data() + 4;
    int st = e[0] & 0x0F, code = e[0] >> 4;
    if (st != 0x0F) {
        uint64_t poh = 0; for (int i = 7; i >= 0; --i) poh = (poh << 8) | e[4 + i];
        o += ",\"last\":{\"type\":\"" + std::string(code == 1 ? "short" : code == 2 ? "long" : "other") + "\",\"result\":\"" + nvmeResult(st) +
             "\",\"code\":" + std::to_string(st) + ",\"hours\":" + std::to_string(poh);
        if ((e[2] & 0x02) && (st == 6 || st == 7)) { uint64_t lba = 0; for (int i = 7; i >= 0; --i) lba = (lba << 8) | e[16 + i]; o += ",\"lba\":" + std::to_string(lba); }
        o += "}";
    }
    out(o + "}");
    return 0;
}

bool nvmeAdminSelfTest(HANDLE h, DWORD stc) {
    const DWORD len = FIELD_OFFSET(STORAGE_PROTOCOL_COMMAND, Command) + STORAGE_PROTOCOL_COMMAND_LENGTH_NVME;
    std::vector<BYTE> buf(len + 64);
    auto* c = (STORAGE_PROTOCOL_COMMAND*)buf.data();
    c->Version = STORAGE_PROTOCOL_STRUCTURE_VERSION;
    c->Length = sizeof(STORAGE_PROTOCOL_COMMAND);
    c->ProtocolType = ProtocolTypeNvme;
    c->Flags = STORAGE_PROTOCOL_COMMAND_FLAG_ADAPTER_REQUEST;
    c->CommandLength = STORAGE_PROTOCOL_COMMAND_LENGTH_NVME;
    c->ErrorInfoLength = 0; c->DataToDeviceTransferLength = 0; c->DataFromDeviceTransferLength = 0;
    c->TimeOutValue = 10;
    c->CommandSpecific = STORAGE_PROTOCOL_SPECIFIC_NVME_ADMIN_COMMAND;
    auto* cmd = (NVME_COMMAND*)c->Command;
    cmd->CDW0.OPC = 0x14;            // Device Self-test
    cmd->NSID = 0xFFFFFFFF;
    cmd->u.GENERAL.CDW10 = stc;      // 1 short, 2 extended, 0Fh abort
    DWORD ret = 0;
    return DeviceIoControl(h, IOCTL_STORAGE_PROTOCOL_COMMAND, buf.data(), (DWORD)buf.size(), buf.data(), (DWORD)buf.size(), &ret, nullptr) && c->ReturnStatus == STORAGE_PROTOCOL_STATUS_SUCCESS;
}

bool scsiSendDiagnostic(HANDLE h, BYTE selfTestCode) {
    struct { SCSI_PASS_THROUGH spt; BYTE sense[32]; } s{};
    s.spt.Length = sizeof(SCSI_PASS_THROUGH);
    s.spt.CdbLength = 6;
    s.spt.SenseInfoLength = sizeof(s.sense);
    s.spt.SenseInfoOffset = offsetof(decltype(s), sense);
    s.spt.DataIn = SCSI_IOCTL_DATA_UNSPECIFIED;
    s.spt.TimeOutValue = 10;
    s.spt.Cdb[0] = 0x1D;                       // SEND DIAGNOSTIC
    s.spt.Cdb[1] = (BYTE)(selfTestCode << 5);  // 001b background short, 010b background extended, 100b abort
    DWORD ret = 0;
    return DeviceIoControl(h, IOCTL_SCSI_PASS_THROUGH, &s, sizeof(s), &s, sizeof(s), &ret, nullptr) && s.spt.ScsiStatus == 0;
}

int nvmeStart(HANDLE h, const std::string& what) {
    DWORD stc = what == "short" ? 1 : what == "long" ? 2 : 0x0F;
    BYTE sd = what == "short" ? 1 : what == "long" ? 2 : 4;
    if (nvmeAdminSelfTest(h, stc)) { out("{\"ok\":true,\"kind\":\"nvme\",\"started\":\"" + what + "\",\"via\":\"admin\"}"); return 0; }
    DWORD e1 = GetLastError();
    if (scsiSendDiagnostic(h, sd)) { out("{\"ok\":true,\"kind\":\"nvme\",\"started\":\"" + what + "\",\"via\":\"scsi\"}"); return 0; }
    out(err("start_unsupported", e1));
    return 1;
}

} // namespace

int runSelfTest(int argc, char** argv) {
    if (argc < 4) { out(err("usage")); return 1; }
    int idx = atoi(argv[2]);
    std::string what = argv[3];
    if (what != "short" && what != "long" && what != "abort" && what != "status") { out(err("usage")); return 1; }
    wchar_t path[64]; swprintf_s(path, L"\\\\.\\PhysicalDrive%d", idx);
    HANDLE h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) { out(err("open_failed", GetLastError())); return 1; }

    STORAGE_PROPERTY_QUERY q{}; q.PropertyId = StorageDeviceProperty; q.QueryType = PropertyStandardQuery;
    BYTE dbuf[1024]{}; DWORD ret = 0;
    bool nvme = DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, &q, sizeof(q), dbuf, sizeof(dbuf), &ret, nullptr) &&
                ((STORAGE_DEVICE_DESCRIPTOR*)dbuf)->BusType == BusTypeNvme;
    int rc = what == "status" ? (nvme ? nvmeStatus(h) : sataStatus(h)) : (nvme ? nvmeStart(h, what) : sataStart(h, what));
    CloseHandle(h);
    return rc;
}
