// smartCheck helper: memory test inside Windows, in the style of MemTest86's main tests.
//
//   smartdisk-helper.exe memtest <passes> [maxMB]
//
// Takes most of the free RAM in 256 MB blocks, locks them in physical memory (VirtualLock, so Windows cannot move
// them to the page file and we really test RAM, not the disk), then runs on all cores:
//   1. address test   each 64-bit word holds its own address (finds address-line and decoding faults)
//   2. moving inversions, all zeros / all ones   (fill, then up: check + write inverse, then down: check + restore)
//   3. moving inversions, 0x55 and a walking one in every byte (0x01 ... 0x80)
//   4. random numbers   two pseudo-random sequences, each then inverted (finds data-dependent and coupling faults)
// Streams JSON lines like the surface scan: start, alloc, progress, done. Stops when stdin closes.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr SIZE_T BLOCK = 256ull << 20;
constexpr size_t WORDS = BLOCK / 8;

std::atomic<bool> g_stop{false};
std::atomic<uint64_t> g_errors{0};
std::mutex g_badMx;
struct Bad { uint64_t offset; uint64_t want, got; };
std::vector<Bad> g_bad;

void out(const std::string& s) { fputs(s.c_str(), stdout); fputc('\n', stdout); fflush(stdout); }

struct Block { volatile uint64_t* p; uint64_t base; };   // base = word index of the block's first word

inline void check(const Block& b, size_t i, uint64_t want, uint64_t got) {
    if (got == want) return;
    g_errors.fetch_add(1, std::memory_order_relaxed);
    std::lock_guard<std::mutex> lk(g_badMx);
    if (g_bad.size() < 20) g_bad.push_back({ (b.base + i) * 8, want, got });
}

inline uint64_t xs(uint64_t& s) { s ^= s << 13; s ^= s >> 7; s ^= s << 17; return s; }

// One step over one block. Each function writes and verifies the whole block.
void tAddress(const Block& b, bool inv) {
    for (size_t i = 0; i < WORDS; i++) b.p[i] = inv ? ~(b.base + i) : (b.base + i);
    for (size_t i = 0; i < WORDS; i++) check(b, i, inv ? ~(b.base + i) : (b.base + i), b.p[i]);
}
void tMovInv(const Block& b, uint64_t pat) {
    for (size_t i = 0; i < WORDS; i++) b.p[i] = pat;
    for (size_t i = 0; i < WORDS; i++) { check(b, i, pat, b.p[i]); b.p[i] = ~pat; }
    for (size_t i = WORDS; i-- > 0;) { check(b, i, ~pat, b.p[i]); b.p[i] = pat; }
    for (size_t i = 0; i < WORDS; i++) check(b, i, pat, b.p[i]);
}
void tRandom(const Block& b, uint64_t seed) {
    uint64_t s = seed ^ (b.base * 0x9E3779B97F4A7C15ull) | 1;
    const uint64_t s0 = s;
    for (size_t i = 0; i < WORDS; i++) b.p[i] = xs(s);
    s = s0;
    for (size_t i = 0; i < WORDS; i++) { const uint64_t v = xs(s); check(b, i, v, b.p[i]); b.p[i] = ~v; }
    s = s0;
    for (size_t i = 0; i < WORDS; i++) check(b, i, ~xs(s), b.p[i]);
}

std::string hex(uint64_t v) { char b[24]; sprintf_s(b, "%llx", (unsigned long long)v); return b; }

}  // namespace

int runMemTest(int argc, char** argv) {
    const int passes = std::max(1, std::min(10, argc > 2 ? atoi(argv[2]) : 1));
    const uint64_t maxBytes = argc > 3 ? (uint64_t)_strtoui64(argv[3], nullptr, 10) << 20 : 0;

    MEMORYSTATUSEX ms{ sizeof ms }; GlobalMemoryStatusEx(&ms);
    // Leave room for Windows and smartCheck itself: 1 GB or 8% of the RAM, whichever is more.
    const uint64_t keep = std::max<uint64_t>(1ull << 30, ms.ullTotalPhys / 12);
    uint64_t target = ms.ullAvailPhys > keep + BLOCK ? ms.ullAvailPhys - keep : BLOCK;
    if (maxBytes && target > maxBytes) target = maxBytes;
    const size_t want = (size_t)std::max<uint64_t>(1, target / BLOCK);

    // Stop when smartCheck closes stdin.
    std::thread([] {
        HANDLE in = GetStdHandle(STD_INPUT_HANDLE); char b[64]; DWORD n = 0;
        if (!in || in == INVALID_HANDLE_VALUE) return;
        while (ReadFile(in, b, sizeof b, &n, nullptr) && n > 0) {}
        g_stop = true;
    }).detach();

    // Allocate and lock. The working set limit is raised as we go, so VirtualLock can keep the pages in RAM.
    std::vector<Block> blocks;
    uint64_t locked = 0;
    HANDLE self = GetCurrentProcess();
    for (size_t k = 0; k < want && !g_stop; k++) {
        void* p = VirtualAlloc(nullptr, BLOCK, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
        if (!p) break;
        const SIZE_T ws = (SIZE_T)(blocks.size() + 1) * BLOCK + (64ull << 20);
        SetProcessWorkingSetSize(self, ws, ws + (64ull << 20));
        if (VirtualLock(p, BLOCK)) locked += BLOCK;
        blocks.push_back({ (volatile uint64_t*)p, (uint64_t)k * WORDS });
        out("{\"type\":\"alloc\",\"n\":" + std::to_string(k + 1) + ",\"of\":" + std::to_string(want) + "}");
    }
    out("{\"type\":\"start\",\"planBytes\":" + std::to_string((uint64_t)blocks.size() * BLOCK) + ",\"totalBytes\":" + std::to_string(ms.ullTotalPhys) +
        ",\"freeBytes\":" + std::to_string(ms.ullAvailPhys) + ",\"lockedBytes\":" + std::to_string(locked) + "}");

    struct Step { const char* name; int kind; uint64_t arg; };
    const Step steps[] = {
        { "address", 0, 0 }, { "address-inv", 1, 0 },
        { "movinv-0", 2, 0 }, { "movinv-55", 2, 0x5555555555555555ull },
        // walking one in every byte (0x01, 0x02 ... 0x80)
        { "movinv-01", 2, 0x0101010101010101ull }, { "movinv-02", 2, 0x0202020202020202ull }, { "movinv-04", 2, 0x0404040404040404ull },
        { "movinv-08", 2, 0x0808080808080808ull }, { "movinv-10", 2, 0x1010101010101010ull }, { "movinv-20", 2, 0x2020202020202020ull },
        { "movinv-40", 2, 0x4040404040404040ull }, { "movinv-80", 2, 0x8080808080808080ull },
        { "random-1", 3, 0x243F6A8885A308D3ull }, { "random-2", 3, 0x13198A2E03707344ull },
    };
    const int nSteps = (int)(sizeof steps / sizeof steps[0]);
    const unsigned threads = std::max(1u, std::min<unsigned>(std::thread::hardware_concurrency(), 32));
    const uint64_t total = (uint64_t)passes * nSteps * blocks.size();
    std::atomic<uint64_t> doneUnits{0};
    uint64_t lastPct = ~0ull;

    for (int pass = 0; pass < passes && !g_stop; pass++) {
        for (int si = 0; si < nSteps && !g_stop; si++) {
            const Step st = steps[si];
            std::atomic<size_t> next{0};
            std::vector<std::thread> pool;
            for (unsigned t = 0; t < threads; t++) pool.emplace_back([&] {
                for (size_t k; !g_stop && (k = next.fetch_add(1)) < blocks.size();) {
                    const Block& b = blocks[k];
                    if (st.kind == 0) tAddress(b, false);
                    else if (st.kind == 1) tAddress(b, true);
                    else if (st.kind == 2) tMovInv(b, st.arg);
                    else tRandom(b, st.arg + pass);
                    doneUnits.fetch_add(1);
                }
            });
            // Progress about twice a second while the step runs.
            for (;;) {
                const uint64_t pct = total ? doneUnits.load() * 1000 / total : 1000;
                if (pct != lastPct) {
                    lastPct = pct;
                    char line[160];
                    sprintf_s(line, "{\"type\":\"progress\",\"pct\":%.1f,\"errors\":%llu,\"pass\":%d,\"test\":\"%s\"}", pct / 10.0, (unsigned long long)g_errors.load(), pass + 1, st.name);
                    out(line);
                }
                if (doneUnits.load() >= (uint64_t)(pass * nSteps + si + 1) * blocks.size() || g_stop) break;
                Sleep(500);
            }
            for (auto& th : pool) th.join();
        }
    }

    std::string bad = "[";
    { std::lock_guard<std::mutex> lk(g_badMx);
      for (size_t i = 0; i < g_bad.size(); i++) bad += (i ? "," : "") + std::string("{\"offset\":") + std::to_string(g_bad[i].offset) + ",\"want\":\"" + hex(g_bad[i].want) + "\",\"got\":\"" + hex(g_bad[i].got) + "\"}"; }
    bad += "]";
    out("{\"type\":\"done\",\"errors\":" + std::to_string(g_errors.load()) + ",\"bad\":" + bad + ",\"testedBytes\":" + std::to_string((uint64_t)blocks.size() * BLOCK) +
        ",\"lockedBytes\":" + std::to_string(locked) + ",\"stopped\":" + (g_stop ? "true" : "false") + "}");
    for (auto& b : blocks) { VirtualUnlock((void*)b.p, BLOCK); VirtualFree((void*)b.p, 0, MEM_RELEASE); }
    return 0;
}
