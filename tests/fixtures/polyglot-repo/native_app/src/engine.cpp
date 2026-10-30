#include <vector>
#include "../include/common.h"

int calculate_core(int a, int b) {
    std::vector<int> v = {a, b};
    return v[0] + v[1];
}

