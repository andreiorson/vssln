#include <engine/platform.h>

// Defined by out\generated\deps.props, which building Deps writes.
#ifndef ENGINE_DEPS
#error "deps.props of the Deps project was not imported"
#endif

namespace engine {

const char* platform_flavor() {
    return ENGINE_FLAVOR[0] ? ENGINE_FLAVOR : "(none)";
}

}  // namespace engine
