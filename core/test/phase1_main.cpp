#include <cstdio>

#include "libretro.h"

// Phase 1 acceptance: link the static melonDS DS library and call the two
// libretro entry points that do not need a frontend or a ROM.
int main() {
  retro_system_info info{};
  retro_get_system_info(&info);

  const unsigned api = retro_api_version();
  std::printf("api_version=%u\n", api);
  std::printf("library_name=%s\n", info.library_name ? info.library_name : "(null)");
  std::printf("library_version=%s\n", info.library_version ? info.library_version : "(null)");
  std::printf("valid_extensions=%s\n", info.valid_extensions ? info.valid_extensions : "(null)");

  return api == RETRO_API_VERSION && info.library_name != nullptr ? 0 : 1;
}
