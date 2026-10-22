#pragma once

#ifdef AUDIO_EXPORTS
#define AUDIO_API __declspec(dllexport)
#else
#define AUDIO_API __declspec(dllimport)
#endif

namespace audio {

AUDIO_API int init();

}  // namespace audio
