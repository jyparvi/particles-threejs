import { struct, wgslFn } from 'three/tsl';

const particleVertexOutput = struct({ position: 'vec4', uv: 'vec2', particle_color: 'vec3' }, 'ParticleVertexOutput');

// Approximate the particle's distance to the D20 object's surface.
export function createDistanceToD20Surface(d20Planes) {
    return wgslFn(`
        fn distance_to_d20_surface(world_position: vec3f, d20_world_to_local: mat4x4f) -> f32
        {
            let local_position = (d20_world_to_local * vec4f(world_position, 1.0f)).xyz;
            var signed_distance = -1.0e+30f;
            for (var i = 0u; i < ${d20Planes.value.count}u; i++)
            {
                let plane = d20_planes.value[i];
                signed_distance = max(signed_distance, dot(plane.xyz, local_position) + plane.w);
            }

            return abs(signed_distance);
        }
    `, [d20Planes]);
}

// Compute a camera-facing particle vertex with velocity-based stretching and distance-based color.
export function createParticleVertex(d20Planes) {
    const distanceToD20Surface = createDistanceToD20Surface(d20Planes);
    return wgslFn(`
        fn particle_vertex(world_position: vec3f, velocity: vec3f, corner: vec2f,
            view_matrix: mat4x4f, projection_matrix: mat4x4f, particle_size: f32, velocity_stretch: f32,
            d20_world_to_local: mat4x4f, near_particle_color: vec3f, far_particle_color: vec3f) -> ParticleVertexOutput
        {
            let clip_position = projection_matrix * (view_matrix * vec4f(world_position, 1.0f));

            var billboard_offset = corner * particle_size;
            let view_velocity = (view_matrix * vec4f(velocity, 0.0f)).xy;
            let view_speed = length(view_velocity);

            if (velocity_stretch > 0.0f && view_speed > 0.0001f)
            {
                let motion_direction = view_velocity / view_speed;
                let side_direction = vec2f(motion_direction.y, -motion_direction.x);
                let half_length = particle_size + view_speed * velocity_stretch * 0.5f;
                billboard_offset = side_direction * corner.x * particle_size + motion_direction * corner.y * half_length;
            }

            let position = vec4f(clip_position.xy + billboard_offset * vec2f(projection_matrix[0][0], projection_matrix[1][1]), clip_position.zw);
            let uv = corner * 0.5f + 0.5f;
            let near_surface = clamp(1.0f - distance_to_d20_surface(world_position, d20_world_to_local) / COLOR_TRANSITION_DISTANCE, 0.0f, 1.0f);
            let particle_color = mix(far_particle_color, near_particle_color, near_surface);
            return ParticleVertexOutput(position, uv, particle_color);
        }

        const COLOR_TRANSITION_DISTANCE = 4.0f;
    `, [distanceToD20Surface, particleVertexOutput]);
}

// Compute the particle's final color with glow and a soft circular edge.
export const particleFragment = wgslFn(`
    fn particle_fragment(particle_color: vec3f, uv: vec2f, glow_color: vec3f, glow_intensity: f32, glow_sharpness: f32) -> vec4f {
        let radius = length(uv - 0.5f) * 2.0f;
        let edge = 1.0f - smoothstep(0.84f, 1.0f, radius);
        let core = pow(clamp(1.0f - radius, 0.0f, 1.0f), max(glow_sharpness, 0.01f));
        let glow = core * glow_intensity;
        let color = mix(particle_color, glow_color, clamp(glow, 0.0f, 1.0f)) * (1.0f + glow);

        return vec4f(color, edge);
    }
`);
