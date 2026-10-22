#include <engine/math.h>

#include "matrix_detail.h"

namespace engine {

float trace3(const float m[9]) {
    float sum = 0;
    for (int i = 0; i < detail::kRows; ++i) sum += m[i * detail::kRows + i];
    return sum;
}

}  // namespace engine
