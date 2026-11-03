#include <thread>

// Phase 0 smoke test: exercises the C++ toolchain and pthread support.
extern "C" int mds_hello() {
  int value = 0;
  std::thread worker([&value] { value = 42; });
  worker.join();
  return value;
}

extern "C" int mds_pthreads_enabled() {
#ifdef __EMSCRIPTEN_PTHREADS__
  return 1;
#else
  return 0;
#endif
}
