// smartCheck helper: high-intensity CPU load for the burn-in test (like Prime95 small FFT: the floating-point units
// run flat out on data that stays in the L1 cache, which is what makes a CPU hottest).
//
//   smartdisk-helper.exe stress [threads]
//
// Prints one JSON line {"ok":true,"mode":"avx2-fma"|"avx"|"sse2","threads":N}, then loads every logical processor
// until stdin is closed (smartCheck ends the test) or the process is killed. Nothing is written to disk.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <intrin.h>
#include <immintrin.h>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> g_stop{false};

bool osSavesAvx() {
    int r[4]; __cpuid(r, 1);
    const bool osxsave = (r[2] & (1 << 27)) != 0, avx = (r[2] & (1 << 28)) != 0;
    if (!osxsave || !avx) return false;
    return (_xgetbv(0) & 6) == 6;   // XMM and YMM state saved by Windows
}
bool hasFma() { int r[4]; __cpuid(r, 1); return (r[2] & (1 << 12)) != 0; }
bool hasAvx2() { int r[4]; __cpuid(r, 0); if (r[0] < 7) return false; __cpuidex(r, 7, 0); return (r[1] & (1 << 5)) != 0; }

// 12 independent FMA chains plus loads from a 16 KB block (L1). Values converge (x*0.9999999 + small), so no
// overflow and no denormals; the result is kept so the compiler cannot drop the work.
alignas(64) double g_sink[64];

void loadFma(int id) {
    alignas(32) static thread_local double buf[2048];
    for (int i = 0; i < 2048; i++) buf[i] = 0.9999 - (i % 97) * 1e-7;   // below 1: every chain converges
    const __m256d m = _mm256_set1_pd(0.9999999), a = _mm256_set1_pd(1e-7);
    __m256d x0 = _mm256_set1_pd(1.0), x1 = x0, x2 = x0, x3 = x0, x4 = x0, x5 = x0, x6 = x0, x7 = x0, x8 = x0, x9 = x0, x10 = x0, x11 = x0;
    while (!g_stop.load(std::memory_order_relaxed)) {
        for (int rep = 0; rep < 64; rep++) {
            for (int i = 0; i < 2048; i += 16) {
                const __m256d b0 = _mm256_load_pd(buf + i), b1 = _mm256_load_pd(buf + i + 4), b2 = _mm256_load_pd(buf + i + 8), b3 = _mm256_load_pd(buf + i + 12);
                x0 = _mm256_fmadd_pd(x0, m, a); x1 = _mm256_fmadd_pd(x1, m, a); x2 = _mm256_fmadd_pd(x2, b0, a); x3 = _mm256_fmadd_pd(x3, m, a);
                x4 = _mm256_fmadd_pd(x4, m, a); x5 = _mm256_fmadd_pd(x5, b1, a); x6 = _mm256_fmadd_pd(x6, m, a); x7 = _mm256_fmadd_pd(x7, m, a);
                x8 = _mm256_fmadd_pd(x8, b2, a); x9 = _mm256_fmadd_pd(x9, m, a); x10 = _mm256_fmadd_pd(x10, m, a); x11 = _mm256_fmadd_pd(x11, b3, a);
                x2 = _mm256_mul_pd(x2, m); x5 = _mm256_mul_pd(x5, m); x8 = _mm256_mul_pd(x8, m); x11 = _mm256_mul_pd(x11, m);
            }
        }
    }
    __m256d s = _mm256_add_pd(_mm256_add_pd(_mm256_add_pd(x0, x1), _mm256_add_pd(x2, x3)), _mm256_add_pd(_mm256_add_pd(x4, x5), _mm256_add_pd(x6, x7)));
    s = _mm256_add_pd(s, _mm256_add_pd(_mm256_add_pd(x8, x9), _mm256_add_pd(x10, x11)));
    _mm256_storeu_pd(g_sink + (id % 16) * 4, s);
}

void loadAvx(int id) {   // AVX without FMA (Sandy Bridge / Ivy Bridge): separate multiply and add chains
    const __m256d m = _mm256_set1_pd(0.9999999), a = _mm256_set1_pd(1e-7);
    __m256d x[12]; for (auto& v : x) v = _mm256_set1_pd(1.0);
    while (!g_stop.load(std::memory_order_relaxed)) {
        for (int rep = 0; rep < 100000; rep++)
            for (int k = 0; k < 12; k++) x[k] = _mm256_add_pd(_mm256_mul_pd(x[k], m), a);
    }
    __m256d s = x[0]; for (int k = 1; k < 12; k++) s = _mm256_add_pd(s, x[k]);
    _mm256_storeu_pd(g_sink + (id % 16) * 4, s);
}

void loadSse(int id) {
    const __m128d m = _mm_set1_pd(0.9999999), a = _mm_set1_pd(1e-7);
    __m128d x[12]; for (auto& v : x) v = _mm_set1_pd(1.0);
    while (!g_stop.load(std::memory_order_relaxed)) {
        for (int rep = 0; rep < 100000; rep++)
            for (int k = 0; k < 12; k++) x[k] = _mm_add_pd(_mm_mul_pd(x[k], m), a);
    }
    __m128d s = x[0]; for (int k = 1; k < 12; k++) s = _mm_add_pd(s, x[k]);
    _mm_storeu_pd(g_sink + (id % 16) * 4, s);
}

}  // namespace

int runStress(int argc, char** argv) {
    SYSTEM_INFO si; GetSystemInfo(&si);
    int threads = argc > 2 ? atoi(argv[2]) : 0;
    const int logical = (int)GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
    if (threads <= 0 || threads > 1024) threads = logical > 0 ? logical : (int)si.dwNumberOfProcessors;
    const bool avx = osSavesAvx();
    const char* mode = avx && hasFma() && hasAvx2() ? "avx2-fma" : avx ? "avx" : "sse2";
    void (*fn)(int) = avx && hasFma() && hasAvx2() ? loadFma : avx ? loadAvx : loadSse;
    printf("{\"ok\":true,\"mode\":\"%s\",\"threads\":%d}\n", mode, threads); fflush(stdout);

    std::vector<std::thread> pool;
    for (int i = 0; i < threads; i++) {
        pool.emplace_back([fn, i] {
            // Below normal: the PC stays usable and smartCheck keeps drawing; the load is the same when nothing else runs.
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
            fn(i);
        });
    }
    // Stop when smartCheck closes our stdin (or exits).
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    char b[64]; DWORD n = 0;
    while (in && in != INVALID_HANDLE_VALUE && ReadFile(in, b, sizeof b, &n, nullptr) && n > 0) {}
    if (!in || in == INVALID_HANDLE_VALUE) for (;;) Sleep(60000);   // no stdin: run until killed
    g_stop = true;
    for (auto& t : pool) t.join();
    return 0;
}
