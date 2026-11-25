cmake_minimum_required(VERSION 3.20)
project(smartdisk_helper CXX)
set(CMAKE_CXX_STANDARD 17)
# Static CRT so the exe runs on a clean Windows install with no VC++ redistributable.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_executable(smartdisk-helper smartdisk-helper.cpp disktests.cpp selftest.cpp disktools.cpp)
target_compile_definitions(smartdisk-helper PRIVATE UNICODE _UNICODE)
