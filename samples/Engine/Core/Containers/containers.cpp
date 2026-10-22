#include "ring_buffer.h"
#include "small_map.h"

namespace engine {

int containers_self_check() {
    SmallMap<int, int, 4> map;
    map.insert(1, 2);
    RingBuffer<int, 2> ring;
    ring.push(1);
    return static_cast<int>(map.size());
}

}  // namespace engine
