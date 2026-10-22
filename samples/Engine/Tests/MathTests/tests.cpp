#include <cmath>
#include <cstdio>

#include <engine/math.h>

static int failures = 0;

static void check(bool ok, const char* what) {
    if (!ok) {
        std::printf("FAIL: %s\n", what);
        ++failures;
    }
}

int main() {
    using engine::Vec3;
    check(engine::dot({1, 2, 3}, {4, 5, 6}) == 32.0f, "dot");
    Vec3 c = engine::cross({1, 0, 0}, {0, 1, 0});
    check(c.x == 0 && c.y == 0 && c.z == 1, "cross");
    const float m[9] = {1, 0, 0, 0, 2, 0, 0, 0, 3};
    check(engine::trace3(m) == 6.0f, "trace3");
    std::printf(failures ? "%d failures\n" : "all tests passed\n", failures);
    return failures ? 1 : 0;
}
