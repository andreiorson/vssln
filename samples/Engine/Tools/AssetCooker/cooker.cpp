#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>

// Reads assets.txt from the working directory, so the debug cwd matters.
int main() {
    std::ifstream in("assets.txt");
    if (!in) {
        std::printf("assets.txt not found in %s\n", std::filesystem::current_path().string().c_str());
        return 1;
    }
    int count = 0;
    for (std::string line; std::getline(in, line);) {
        if (!line.empty()) ++count;
    }
    std::printf("cooked %d assets\n", count);
    return 0;
}
