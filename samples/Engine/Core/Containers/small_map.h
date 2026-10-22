#pragma once

#include <utility>

#include "fixed_vector.h"

namespace engine {

template <typename K, typename V, std::size_t N>
class SmallMap {
public:
    bool insert(const K& key, const V& value) { return items_.push_back({key, value}); }
    std::size_t size() const { return items_.size(); }

private:
    FixedVector<std::pair<K, V>, N> items_;
};

}  // namespace engine
