#include <cstdio>
#include <cstdlib>
#include <filesystem>

#include <engine/audio.h>
#include <engine/math.h>
#include <engine/platform.h>
#include <engine/render.h>

int main(int argc, char** argv) {
    std::printf("args:");
    for (int i = 1; i < argc; ++i) std::printf(" %s", argv[i]);
    std::printf("\n");

    std::printf("cwd: %s\n", std::filesystem::current_path().string().c_str());

    char* mode = nullptr;
    size_t length = 0;
    _dupenv_s(&mode, &length, "GAME_MODE");
    std::printf("GAME_MODE: %s\n", mode ? mode : "(unset)");
    std::free(mode);

    std::printf("flavor: %s\n", engine::platform_flavor());
    std::printf("audio: %d, shaders: %d\n", audio::init(), render::shader_count());
    std::printf("dot: %.1f, frame: %.2f\n", engine::dot({1, 2, 3}, {4, 5, 6}), render::frame(0.5f));
    return 0;
}
