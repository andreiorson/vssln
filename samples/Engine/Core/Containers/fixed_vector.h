#pragma once

#include <array>
#include <cstddef>

namespace engine {

template <typename T, std::size_t N>
class FixedVector {
public:
    bool push_back(const T& value) {
        if (size_ == N) return false;
        items_[size_++] = value;
        return true;
    }
    std::size_t size() const { return size_; }
    const T& operator[](std::size_t i) const { return items_[i]; }

private:
    std::array<T, N> items_{};
    std::size_t size_ = 0;
};

}  // namespace engine
