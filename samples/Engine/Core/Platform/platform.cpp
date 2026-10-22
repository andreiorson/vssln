#include <engine/platform.h>

namespace engine {

const char* platform_flavor() {
    return ENGINE_FLAVOR[0] ? ENGINE_FLAVOR : "(none)";
}

}  // namespace engine
