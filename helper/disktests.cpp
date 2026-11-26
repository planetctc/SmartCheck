// smartCheck helper: benchmark and read-only surface scan.
// Both stream one JSON object per line on stdout so the app can show progress; the app cancels by killing the process.
//
//   smartdisk-helper.exe bench <letter> [sizeMiB]   -> sequential / random read+write speed, using a temp file on that volume
//   smartdisk-helper.exe scan <diskIndex>           -> reads every sector of \\.\PhysicalDriveN (never writes)

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winioctl.h>
#include <cstdint>
#include <cstdarg>
#include <cctype>
#include <cstdlib>
#include <cstdio>
#include <string>
#include <vector>

static void emit(const char* fmt, ...) {
    va_list ap; va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    fputc('\n', stdout);
    fflush(stdout);
}

static double now() {
    static LARGE_INTEGER f = [] { LARGE_INTEGER x; QueryPerformanceFrequency(&x); return x; }();
    LARGE_INTEGER c; QueryPerformanceCounter(&c);
    return double(c.QuadPart) / double(f.QuadPart);
}

static uint64_t rng = 0x9E3779B97F4A7C15ull;
static uint64_t next() { rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17; return rng; }

// =====================================================================
// Benchmark
// =====================================================================

struct IoResult { double mbps = 0, iops = 0; bool ok = true; };

// Keeps `qd` overlapped requests in flight for `seconds`. Sequential tests walk the file and wrap around.
// Writes take their data from a large random pool (rotating offset) so no two blocks repeat;
// reads land in per-slot buffers.
const size_t POOL = size_t(64) << 20;

static IoResult runIo(HANDLE h, uint64_t fileSize, DWORD block, int qd, bool write, bool sequential, double seconds, BYTE* buf, BYTE* pool) {
    std::vector<OVERLAPPED> ov(qd);
    std::vector<HANDLE> ev(qd);
    for (int i = 0; i < qd; ++i) { ev[i] = CreateEventW(nullptr, TRUE, FALSE, nullptr); }
    const uint64_t blocks = fileSize / block;
    uint64_t seq = 0, bytes = 0, ops = 0, poolOff = 0;
    IoResult r;

    auto issue = [&](int i) -> bool {
        uint64_t idx = sequential ? (seq++ % blocks) : (next() % blocks);
        uint64_t off = idx * block;
        ZeroMemory(&ov[i], sizeof(OVERLAPPED));
        ov[i].hEvent = ev[i];
        ResetEvent(ev[i]);
        ov[i].Offset = DWORD(off); ov[i].OffsetHigh = DWORD(off >> 32);
        BYTE* p = buf + size_t(i) * block;
        if (write) { p = pool + poolOff; poolOff = (poolOff + block) % (POOL - block + 1) / 4096 * 4096; }
        BOOL ok = write ? WriteFile(h, p, block, nullptr, &ov[i]) : ReadFile(h, p, block, nullptr, &ov[i]);
        return ok || GetLastError() == ERROR_IO_PENDING;
    };

    double t0 = now(), end = t0 + seconds;
    for (int i = 0; i < qd; ++i) if (!issue(i)) { r.ok = false; break; }
    int pending = r.ok ? qd : 0;
    while (pending > 0) {
        DWORD w = WaitForMultipleObjects(DWORD(qd), ev.data(), FALSE, 5000);
        if (w == WAIT_TIMEOUT) continue;
        int i = int(w - WAIT_OBJECT_0);
        if (i < 0 || i >= qd) { r.ok = false; break; }
        DWORD got = 0;
        if (!GetOverlappedResult(h, &ov[i], &got, FALSE)) { r.ok = false; ResetEvent(ev[i]); --pending; continue; }
        bytes += got; ++ops;
        if (now() < end && r.ok) { if (!issue(i)) { r.ok = false; ResetEvent(ev[i]); --pending; } }
        else { ResetEvent(ev[i]); --pending; }
    }
    double dt = now() - t0;
    if (dt > 0) { r.mbps = bytes / dt / 1e6; r.iops = ops / dt; }
    for (auto e : ev) CloseHandle(e);
    return r;
}

int runBench(int argc, char** argv) {
    if (argc < 3 || !isalpha((unsigned char)argv[2][0])) { emit("{\"type\":\"error\",\"message\":\"usage: bench <letter> [sizeMiB]\"}"); return 1; }
    wchar_t letter = wchar_t(toupper((unsigned char)argv[2][0]));
    uint64_t sizeMiB = argc > 3 ? _strtoui64(argv[3], nullptr, 10) : 1024;
    if (sizeMiB < 64) sizeMiB = 64;
    if (sizeMiB > 8192) sizeMiB = 8192;
    const uint64_t fileSize = sizeMiB << 20;

    wchar_t root[] = { letter, L':', L'\\', 0 };
    ULARGE_INTEGER freeBytes{};
    if (!GetDiskFreeSpaceExW(root, &freeBytes, nullptr, nullptr)) { emit("{\"type\":\"error\",\"message\":\"cannot read free space\"}"); return 1; }
    if (freeBytes.QuadPart < fileSize + (256ull << 20)) {
        emit("{\"type\":\"error\",\"code\":\"nospace\",\"message\":\"not enough free space\",\"free\":%llu}", freeBytes.QuadPart);
        return 1;
    }

    wchar_t path[64]; swprintf_s(path, L"%c:\\smartCheck-bench.tmp", letter);
    DeleteFileW(path);   // leftover from a killed run
    HANDLE h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
        FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH |
        FILE_FLAG_OVERLAPPED | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
    if (h == INVALID_HANDLE_VALUE) { emit("{\"type\":\"error\",\"message\":\"cannot create test file (%lu)\"}", GetLastError()); return 1; }

    const DWORD maxBlock = 1 << 20; const int maxQd = 32;
    BYTE* buf = (BYTE*)VirtualAlloc(nullptr, size_t(maxBlock) * 8 > size_t(4096) * maxQd ? size_t(maxBlock) * 8 : size_t(4096) * maxQd,
                                    MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    BYTE* pool = (BYTE*)VirtualAlloc(nullptr, POOL, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!buf || !pool) { CloseHandle(h); emit("{\"type\":\"error\",\"message\":\"out of memory\"}"); return 1; }
    // Random content so compressing controllers can't cheat.
    for (size_t i = 0; i < POOL / 8; ++i) ((uint64_t*)pool)[i] = next();

    emit("{\"type\":\"start\",\"sizeMiB\":%llu,\"tests\":6}", sizeMiB);

    // Prepare: fill the whole file once so reads hit real data.
    emit("{\"type\":\"phase\",\"name\":\"prepare\"}");
    {
        OVERLAPPED o{}; o.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        double last = now();
        for (uint64_t off = 0; off < fileSize; off += maxBlock) {
            o.Offset = DWORD(off); o.OffsetHigh = DWORD(off >> 32); ResetEvent(o.hEvent);
            DWORD got = 0;
            BYTE* src = pool + size_t(off % POOL);
            if (off && off % POOL == 0) for (size_t i = 0; i < POOL / 8; ++i) ((uint64_t*)pool)[i] ^= next();
            BOOL ok = WriteFile(h, src, maxBlock, nullptr, &o);
            if (!ok && GetLastError() != ERROR_IO_PENDING) { emit("{\"type\":\"error\",\"message\":\"write failed (%lu)\"}", GetLastError()); CloseHandle(o.hEvent); CloseHandle(h); return 1; }
            if (!GetOverlappedResult(h, &o, &got, TRUE)) { emit("{\"type\":\"error\",\"message\":\"write failed (%lu)\"}", GetLastError()); CloseHandle(o.hEvent); CloseHandle(h); return 1; }
            if (now() - last > 0.5) { last = now(); emit("{\"type\":\"progress\",\"phase\":\"prepare\",\"pct\":%.1f}", 100.0 * off / fileSize); }
        }
        CloseHandle(o.hEvent);
    }

    struct T { const char* name; DWORD block; int qd; bool write; bool seq; };
    const T tests[] = {
        { "seqRead",   1 << 20, 8,  false, true  },
        { "seqWrite",  1 << 20, 8,  true,  true  },
        { "rnd4kQ32Read",  4096, 32, false, false },
        { "rnd4kQ32Write", 4096, 32, true,  false },
        { "rnd4kQ1Read",   4096, 1,  false, false },
        { "rnd4kQ1Write",  4096, 1,  true,  false },
    };
    for (const auto& t : tests) {
        emit("{\"type\":\"phase\",\"name\":\"%s\"}", t.name);
        Sleep(5000);  // rest between tests, like CrystalDiskMark's default interval
        IoResult r = runIo(h, fileSize, t.block, t.qd, t.write, t.seq, 5.0, buf, pool);
        emit("{\"type\":\"result\",\"test\":\"%s\",\"mbps\":%.1f,\"iops\":%.0f,\"ok\":%s}", t.name, r.mbps, r.iops, r.ok ? "true" : "false");
    }
    CloseHandle(h);   // DELETE_ON_CLOSE removes the file
    VirtualFree(buf, 0, MEM_RELEASE);
    VirtualFree(pool, 0, MEM_RELEASE);
    emit("{\"type\":\"done\"}");
    return 0;
}

// =====================================================================
// Surface scan (read-only)
// =====================================================================

int runScan(int argc, char** argv) {
    if (argc < 3) { emit("{\"type\":\"error\",\"message\":\"usage: scan <diskIndex>\"}"); return 1; }
    int idx = atoi(argv[2]);
    wchar_t path[64]; swprintf_s(path, L"\\\\.\\PhysicalDrive%d", idx);
    // GENERIC_READ only: the scan never writes to the disk.
    HANDLE h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_NO_BUFFERING, nullptr);
    if (h == INVALID_HANDLE_VALUE) { emit("{\"type\":\"error\",\"message\":\"cannot open disk (%lu)\"}", GetLastError()); return 1; }

    DWORD ret = 0;
    GET_LENGTH_INFORMATION len{};
    if (!DeviceIoControl(h, IOCTL_DISK_GET_LENGTH_INFO, nullptr, 0, &len, sizeof(len), &ret, nullptr)) {
        emit("{\"type\":\"error\",\"message\":\"cannot read disk size\"}"); CloseHandle(h); return 1;
    }
    DISK_GEOMETRY_EX geo{};
    DWORD sector = 512;
    if (DeviceIoControl(h, IOCTL_DISK_GET_DRIVE_GEOMETRY_EX, nullptr, 0, &geo, sizeof(geo), &ret, nullptr) && geo.Geometry.BytesPerSector)
        sector = geo.Geometry.BytesPerSector;

    const uint64_t total = uint64_t(len.Length.QuadPart) / sector * sector;
    const DWORD chunk = 1 << 20;
    const int CELLS = 1000;
    const double SLOW = 0.2, VERY_SLOW = 0.6;   // seconds per 1 MiB read
    BYTE* buf = (BYTE*)VirtualAlloc(nullptr, chunk, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);

    emit("{\"type\":\"start\",\"size\":%llu,\"sector\":%lu,\"cells\":%d}", total, sector, CELLS);

    std::vector<int> cell(CELLS, -1);
    std::vector<uint64_t> badLbas;
    uint64_t bad = 0, slow = 0, verySlow = 0, pos = 0;
    double t0 = now(), lastEmit = t0;
    std::string pendingCells;   // finished cells not yet sent, starting at pendingFrom
    int pendingFrom = 0, lastCell = -1;

    auto readAt = [&](uint64_t off, DWORD n, DWORD& got) {
        LARGE_INTEGER li; li.QuadPart = LONGLONG(off);
        if (!SetFilePointerEx(h, li, nullptr, FILE_BEGIN)) return false;
        return ReadFile(h, buf, n, &got, nullptr) && got == n;
    };
    auto flushCells = [&](int upTo) {
        for (int c = lastCell + 1; c <= upTo && c < CELLS; ++c) {
            if (cell[c] < 0) cell[c] = 0;
            if (pendingCells.empty()) pendingFrom = c;
            pendingCells += (pendingCells.empty() ? "" : ",") + std::to_string(cell[c]);
        }
        if (upTo > lastCell) lastCell = upTo;
    };

    while (pos < total) {
        DWORD n = DWORD(total - pos < chunk ? total - pos : chunk);
        DWORD got = 0;
        double s = now();
        bool ok = readAt(pos, n, got);
        double dt = now() - s;
        int state = 0;   // 0 ok, 1 slow, 2 very slow, 3 unreadable
        if (!ok) {
            // Re-read this chunk sector by sector to find the bad ones.
            uint64_t badHere = 0;
            for (uint64_t off = pos; off < pos + n; off += sector) {
                DWORD g = 0;
                if (!readAt(off, sector, g)) { ++badHere; if (badLbas.size() < 200) badLbas.push_back(off / sector); }
            }
            bad += badHere;
            if (badHere) state = 3;
            else if (dt >= VERY_SLOW) { state = 2; ++verySlow; }
            else if (dt >= SLOW) { state = 1; ++slow; }
        } else if (dt >= VERY_SLOW) { state = 2; ++verySlow; }
        else if (dt >= SLOW) { state = 1; ++slow; }

        int c = int((pos * CELLS) / total);
        if (state > cell[c]) cell[c] = state;
        pos += n;
        int doneCell = int((pos * CELLS) / total) - 1;
        if (pos >= total) doneCell = CELLS - 1;
        if (doneCell > lastCell) flushCells(doneCell);

        double t = now();
        if (t - lastEmit >= 0.5 || pos >= total) {
            lastEmit = t;
            double el = t - t0;
            emit("{\"type\":\"progress\",\"pct\":%.2f,\"done\":%llu,\"mbps\":%.1f,\"elapsed\":%.0f,\"bad\":%llu,\"slow\":%llu,\"verySlow\":%llu,\"from\":%d,\"cells\":[%s]}",
                 100.0 * pos / total, pos, el > 0 ? pos / el / 1e6 : 0.0, el, bad, slow, verySlow,
                 pendingCells.empty() ? lastCell + 1 : pendingFrom, pendingCells.c_str());
            pendingCells.clear();
        }
    }
    CloseHandle(h);
    VirtualFree(buf, 0, MEM_RELEASE);

    std::string lbas;
    for (size_t i = 0; i < badLbas.size(); ++i) lbas += (i ? "," : "") + std::to_string(badLbas[i]);
    emit("{\"type\":\"done\",\"bad\":%llu,\"slow\":%llu,\"verySlow\":%llu,\"seconds\":%.0f,\"badLbas\":[%s]}",
         bad, slow, verySlow, now() - t0, lbas.c_str());
    return 0;
}
