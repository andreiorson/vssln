#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>

// Reads assets.txt from the working directory, so the debug cwd matters, and writes cooked.txt there with what it
// was started with: tests read it to check the program, working directory, arguments and environment of a launch.
int main(int argc, char** argv) {
    std::ifstream in("assets.txt");
    if (!in) {
        std::printf("assets.txt not found in %s\n", std::filesystem::current_path().string().c_str());
        return 1;
    }
    int count = 0;
    for (std::string line; std::getline(in, line);) {
        if (!line.empty()) ++count;
    }

    std::string args;
    for (int i = 1; i < argc; ++i) {
        if (i > 1) args += ' ';
        args += argv[i];
    }
    char* mode = nullptr;
    size_t length = 0;
    _dupenv_s(&mode, &length, "COOK_MODE");

    std::ofstream out("cooked.txt");
    out << "assets=" << count << "\n";
    out << "args=" << args << "\n";
    out << "COOK_MODE=" << (mode ? mode : "(unset)") << "\n";
    std::free(mode);

    std::printf("cooked %d assets\n", count);
    return 0;
}
