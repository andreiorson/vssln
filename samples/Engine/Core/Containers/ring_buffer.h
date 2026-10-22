#pragma once

#include "fixed_vector.h"

namespace engine {

template <typename T, std::size_t N>
class RingBuffer {
public:
    void push(const T& value) {
        items_[head_] = value;
        head_ = (head_ + 1) % N;
    }

private:
    T items_[N]{};
    std::size_t head_ = 0;
};

}  // namespace engine
