#pragma once

#ifdef RENDER_EXPORTS
#define RENDER_API __declspec(dllexport)
#else
#define RENDER_API __declspec(dllimport)
#endif

namespace render {

RENDER_API int shader_count();
RENDER_API float frame(float t);

}  // namespace render
