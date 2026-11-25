// smartPC helper: fake-capacity check and secure erase. Both stream JSON lines like the surface scan.
//
//   smartdisk-helper.exe capacity <letter>
//       Fills the FREE space of the volume with test files (existing files are not touched), reads them back and
//       checks every byte, then deletes them. Finds fake-capacity USB sticks / SSDs (like H2testw).
//   smartdisk-helper.exe erase <diskIndex> ERASE-<diskIndex> [auto|zero|nvme]
//       Destroys ALL data on \\.\PhysicalDriveN. Refuses the Windows system disk and the disk smartPC runs from.
//       nvme: IOCTL_STORAGE_REINITIALIZE_MEDIA (NVMe Format / sanitize, seconds). zero: overwrite every sector.
//       auto: nvme for NVMe drives (falls back to zero), zero otherwise.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winioctl.h>
#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

void emit(const char* fmt, ...) {
    va_list ap; va_start(ap, fmt); vprintf(fmt, ap); va_end(ap);
    fputc('\n', stdout); fflush(stdout);
}

double now() {
    static LARGE_INTEGER f = [] { LARGE_INTEGER x; QueryPerformanceFrequency(&x); return x; }();
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    return double(c.QuadPart) / double(f.QuadPart);
}

// Deterministic pattern: every 8 bytes depend on their absolute position in the test, so a drive that maps
// two addresses onto the same flash (the usual fake-capacity trick) gives back the wrong data.
inline uint64_t mix(uint64_t x) {
    x ^= x >> 33; x *= 0xff51afd7ed558ccdull; x ^= x >> 33; x *= 0xc4ceb9fe1a85ec53ull; x ^= x >> 33; return x;
}
void fill(uint64_t* p, size_t words, uint64_t pos) {
    for (size_t i = 0; i < words; ++i) p[i] = mix(pos + i * 8 + 0x5D15C0DEull);
}

const uint64_t FILE_BYTES = 1ull << 30;   // 1 GiB per test file
const DWORD CHUNK = 4u << 20;             // 4 MiB per write / read

} // namespace

// =====================================================================
// Fake-capacity check
// =====================================================================
int runCapacity(int argc, char** argv) {
    if (argc < 3 || !isalpha((unsigned char)argv[2][0])) { emit("{\"type\":\"error\",\"message\":\"usage: capacity <letter>\"}"); return 1; }
    wchar_t L = (wchar_t)toupper((unsigned char)argv[2][0]);
    wchar_t root[] = { L, L':', L'\\', 0 };
    std::wstring dir = std::wstring(root) + L"smartPC-capacity-test";
    CreateDirectoryW(dir.c_str(), nullptr);

    ULARGE_INTEGER freeBytes{}, totalBytes{};
    if (!GetDiskFreeSpaceExW(root, &freeBytes, &totalBytes, nullptr)) { emit("{\"type\":\"error\",\"message\":\"cannot read free space\"}"); return 1; }
    const uint64_t reserve = 16ull << 20;
    uint64_t target = freeBytes.QuadPart > reserve ? (freeBytes.QuadPart - reserve) / CHUNK * CHUNK : 0;
    if (target < CHUNK) { emit("{\"type\":\"error\",\"code\":\"nospace\",\"message\":\"not enough free space\"}"); return 1; }
    emit("{\"type\":\"start\",\"total\":%llu,\"free\":%llu,\"target\":%llu}", totalBytes.QuadPart, freeBytes.QuadPart, target);

    uint64_t* buf = (uint64_t*)VirtualAlloc(nullptr, CHUNK, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    uint64_t* exp = (uint64_t*)VirtualAlloc(nullptr, CHUNK, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    std::vector<std::wstring> files;
    auto fileName = [&](size_t i) { wchar_t n[64]; swprintf_s(n, L"\\test%04zu.bin", i + 1); return dir + n; };

    // ---- write ----
    uint64_t written = 0; bool writeFailed = false; DWORD writeErr = 0;
    double t0 = now(), last = t0;
    while (written < target && !writeFailed) {
        std::wstring fn = fileName(files.size());
        HANDLE h = CreateFileW(fn.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH, nullptr);
        if (h == INVALID_HANDLE_VALUE) { writeFailed = true; writeErr = GetLastError(); break; }
        files.push_back(fn);
        uint64_t inFile = 0;
        while (inFile < FILE_BYTES && written < target) {
            fill(buf, CHUNK / 8, written);
            DWORD n = 0;
            if (!WriteFile(h, buf, CHUNK, &n, nullptr) || n != CHUNK) { writeFailed = true; writeErr = GetLastError(); break; }
            inFile += CHUNK; written += CHUNK;
            double t = now();
            if (t - last >= 0.5) { last = t; emit("{\"type\":\"progress\",\"phase\":\"write\",\"pct\":%.2f,\"done\":%llu,\"mbps\":%.1f}", 100.0 * written / target, written, written / (t - t0) / 1e6); }
        }
        CloseHandle(h);
    }
    double writeMbps = written / std::max(0.001, now() - t0) / 1e6;

    // ---- verify ----
    uint64_t pos = 0, okBytes = 0, badBytes = 0, firstBad = UINT64_MAX;
    double t1 = now(); last = t1;
    for (size_t fi = 0; fi < files.size() && pos < written; ++fi) {
        HANDLE h = CreateFileW(files[fi].c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_NO_BUFFERING | FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
        uint64_t inFile = 0;
        while (inFile < FILE_BYTES && pos < written) {
            DWORD n = 0;
            bool ok = h != INVALID_HANDLE_VALUE && ReadFile(h, buf, CHUNK, &n, nullptr) && n == CHUNK;
            fill(exp, CHUNK / 8, pos);
            uint64_t good = 0;
            if (ok) for (size_t i = 0; i < CHUNK / 8; ++i) { if (buf[i] == exp[i]) good += 8; else if (firstBad == UINT64_MAX) firstBad = pos + i * 8; }
            else if (firstBad == UINT64_MAX) firstBad = pos;
            okBytes += good; badBytes += CHUNK - good;
            inFile += CHUNK; pos += CHUNK;
            double t = now();
            if (t - last >= 0.5) { last = t; emit("{\"type\":\"progress\",\"phase\":\"verify\",\"pct\":%.2f,\"done\":%llu,\"mbps\":%.1f,\"bad\":%llu}", 100.0 * pos / written, pos, (pos) / (t - t1) / 1e6, badBytes); }
            if (!ok) { // skip the rest of an unreadable file
                badBytes += std::min<uint64_t>(FILE_BYTES - inFile, written - pos);
                pos += std::min<uint64_t>(FILE_BYTES - inFile, written - pos);
                break;
            }
        }
        if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    }
    double readMbps = pos / std::max(0.001, now() - t1) / 1e6;

    for (auto& f : files) DeleteFileW(f.c_str());
    RemoveDirectoryW(dir.c_str());
    VirtualFree(buf, 0, MEM_RELEASE); VirtualFree(exp, 0, MEM_RELEASE);

    emit("{\"type\":\"done\",\"total\":%llu,\"free\":%llu,\"tested\":%llu,\"okBytes\":%llu,\"badBytes\":%llu,\"firstBad\":%lld,\"writeFailed\":%s,\"writeError\":%lu,\"writeMbps\":%.1f,\"readMbps\":%.1f}",
         totalBytes.QuadPart, freeBytes.QuadPart, written, okBytes, badBytes, firstBad == UINT64_MAX ? -1LL : (long long)firstBad,
         writeFailed ? "true" : "false", writeErr, writeMbps, readMbps);
    return 0;
}

// =====================================================================
// Secure erase
// =====================================================================
namespace {

int diskNumberOfVolume(const wchar_t* vol) {   // vol like L"\\\\.\\C:"
    HANDLE h = CreateFileW(vol, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return -1;
    STORAGE_DEVICE_NUMBER sdn{}; DWORD ret = 0;
    BOOL ok = DeviceIoControl(h, IOCTL_STORAGE_GET_DEVICE_NUMBER, nullptr, 0, &sdn, sizeof(sdn), &ret, nullptr);
    CloseHandle(h);
    return ok ? (int)sdn.DeviceNumber : -1;
}

int diskOfLetter(wchar_t letter) { wchar_t v[] = { L'\\', L'\\', L'.', L'\\', letter, L':', 0 }; return diskNumberOfVolume(v); }

} // namespace

int runErase(int argc, char** argv) {
    if (argc < 4) { emit("{\"type\":\"error\",\"message\":\"usage: erase <diskIndex> ERASE-<diskIndex> [auto|zero|nvme]\"}"); return 1; }
    int idx = atoi(argv[2]);
    if (std::string(argv[3]) != "ERASE-" + std::to_string(idx)) { emit("{\"type\":\"error\",\"code\":\"confirm\",\"message\":\"confirmation token does not match\"}"); return 1; }
    std::string method = argc > 4 ? argv[4] : "auto";

    // Never the Windows disk, never the disk smartPC itself runs from.
    wchar_t sysDir[MAX_PATH]{}, exe[MAX_PATH]{};
    GetSystemDirectoryW(sysDir, MAX_PATH);
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    if (diskOfLetter(sysDir[0]) == idx || diskOfLetter(exe[0]) == idx) { emit("{\"type\":\"error\",\"code\":\"system\",\"message\":\"this is the Windows / smartPC disk\"}"); return 1; }

    // Lock and dismount every volume on the disk; keep the handles open until the end.
    std::vector<HANDLE> locks;
    DWORD mask = GetLogicalDrives();
    for (int i = 0; i < 26; ++i) {
        if (!(mask & (1u << i))) continue;
        wchar_t v[] = { L'\\', L'\\', L'.', L'\\', wchar_t(L'A' + i), L':', 0 };
        if (diskNumberOfVolume(v) != idx) continue;
        HANDLE h = CreateFileW(v, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
        DWORD ret = 0;
        if (h == INVALID_HANDLE_VALUE || !DeviceIoControl(h, FSCTL_LOCK_VOLUME, nullptr, 0, nullptr, 0, &ret, nullptr)) {
            if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
            for (HANDLE l : locks) CloseHandle(l);
            emit("{\"type\":\"error\",\"code\":\"inuse\",\"message\":\"drive %c: is in use; close its files and windows\"}", char('A' + i));
            return 1;
        }
        DeviceIoControl(h, FSCTL_DISMOUNT_VOLUME, nullptr, 0, nullptr, 0, &ret, nullptr);
        locks.push_back(h);
    }

    wchar_t path[64]; swprintf_s(path, L"\\\\.\\PhysicalDrive%d", idx);
    HANDLE h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH, nullptr);
    if (h == INVALID_HANDLE_VALUE) { for (HANDLE l : locks) CloseHandle(l); emit("{\"type\":\"error\",\"message\":\"cannot open disk (%lu)\"}", GetLastError()); return 1; }
    DWORD ret = 0;
    GET_LENGTH_INFORMATION len{};
    DeviceIoControl(h, IOCTL_DISK_GET_LENGTH_INFO, nullptr, 0, &len, sizeof(len), &ret, nullptr);
    STORAGE_PROPERTY_QUERY q{}; q.PropertyId = StorageDeviceProperty; q.QueryType = PropertyStandardQuery;
    BYTE dbuf[1024]{};
    bool nvme = DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, &q, sizeof(q), dbuf, sizeof(dbuf), &ret, nullptr) &&
                ((STORAGE_DEVICE_DESCRIPTOR*)dbuf)->BusType == BusTypeNvme;
    const uint64_t total = (uint64_t)len.Length.QuadPart / 4096 * 4096;
    emit("{\"type\":\"start\",\"size\":%llu,\"nvme\":%s}", total, nvme ? "true" : "false");
    double t0 = now();

    if ((method == "auto" && nvme) || method == "nvme") {
        emit("{\"type\":\"phase\",\"name\":\"nvme\"}");
        STORAGE_REINITIALIZE_MEDIA rm{};
        rm.Version = sizeof(STORAGE_REINITIALIZE_MEDIA);
        rm.Size = sizeof(STORAGE_REINITIALIZE_MEDIA);
        rm.TimeoutInSeconds = 600;
        rm.SanitizeOption.SanitizeMethod = StorageSanitizeMethodDefault;
        if (DeviceIoControl(h, IOCTL_STORAGE_REINITIALIZE_MEDIA, &rm, sizeof(rm), nullptr, 0, &ret, nullptr)) {
            DeviceIoControl(h, IOCTL_DISK_UPDATE_PROPERTIES, nullptr, 0, nullptr, 0, &ret, nullptr);
            CloseHandle(h); for (HANDLE l : locks) CloseHandle(l);
            emit("{\"type\":\"done\",\"method\":\"nvme\",\"seconds\":%.0f}", now() - t0);
            return 0;
        }
        DWORD e = GetLastError();
        if (method == "nvme") { CloseHandle(h); for (HANDLE l : locks) CloseHandle(l); emit("{\"type\":\"error\",\"code\":\"nvme_unsupported\",\"message\":\"NVMe format not supported (%lu)\"}", e); return 1; }
        emit("{\"type\":\"info\",\"message\":\"NVMe format not supported (%lu), overwriting instead\"}", e);
    }

    emit("{\"type\":\"phase\",\"name\":\"zero\"}");
    BYTE* zero = (BYTE*)VirtualAlloc(nullptr, CHUNK, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);   // zero-filled
    uint64_t pos = 0, errors = 0; double last = t0;
    while (pos < total) {
        DWORD n = (DWORD)std::min<uint64_t>(CHUNK, total - pos), got = 0;
        LARGE_INTEGER li; li.QuadPart = (LONGLONG)pos;
        if (!SetFilePointerEx(h, li, nullptr, FILE_BEGIN) || !WriteFile(h, zero, n, &got, nullptr) || got != n) ++errors;
        pos += n;
        double t = now();
        if (t - last >= 0.5 || pos >= total) { last = t; emit("{\"type\":\"progress\",\"pct\":%.2f,\"done\":%llu,\"mbps\":%.1f,\"elapsed\":%.0f,\"errors\":%llu}", 100.0 * pos / total, pos, pos / std::max(0.001, t - t0) / 1e6, t - t0, errors); }
    }
    DeviceIoControl(h, IOCTL_DISK_UPDATE_PROPERTIES, nullptr, 0, nullptr, 0, &ret, nullptr);
    VirtualFree(zero, 0, MEM_RELEASE);
    CloseHandle(h);
    for (HANDLE l : locks) CloseHandle(l);
    emit("{\"type\":\"done\",\"method\":\"zero\",\"seconds\":%.0f,\"errors\":%llu}", now() - t0, errors);
    return 0;
}
