import { wgslFn } from 'three/tsl';

// Apply film grain that changes each frame, with reduced strength in brighter pixels.
export const filmGrain = wgslFn(`
    fn film_grain(color: vec3f, screen_pixel: vec2f, frame_index: u32, film_grain_amount: f32) -> vec4f {
        let pixel = vec2u(screen_pixel);
        var hash = (pixel.x * 1597334677u) ^ (pixel.y * 3812015801u) ^ (frame_index * 2798796415u);
        hash = (hash ^ (hash >> 16u)) * 0x7feb352du;
        hash = (hash ^ (hash >> 15u)) * 0x846ca68bu;
        hash ^= hash >> 16u;
        let noise = (f32(hash & 0x00ffffffu) / 16777216.0f) - 0.5f;
        let grain = noise * film_grain_amount * 0.6f * (1.0f - 0.8f * sqrt(max(dot(color, vec3f(0.21f, 0.72f, 0.07f)), 0.0f)));
        return vec4f(color * (1.0f + grain), 1.0f);
    }
`);
