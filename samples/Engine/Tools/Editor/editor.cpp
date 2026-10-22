#include <cstdio>

#include <engine/render.h>

int main() {
    std::printf("Editor: %d shaders, frame %.2f\n", render::shader_count(), render::frame(1.0f));
    return 0;
}
