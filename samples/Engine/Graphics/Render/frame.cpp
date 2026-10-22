#include "pch.h"

#include <engine/render.h>

namespace render {

float frame(float t) {
    return engine::dot({t, t, t}, {1, 1, 1}) + std::sin(t);
}

}  // namespace render
