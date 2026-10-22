#pragma once

namespace engine {

struct Vec3 {
    float x, y, z;
};

float dot(const Vec3& a, const Vec3& b);
Vec3 cross(const Vec3& a, const Vec3& b);
float trace3(const float m[9]);

}  // namespace engine
