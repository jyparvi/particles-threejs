import { wgslFn } from 'three/tsl';

// Create the particle simulation shader with the shared D20 plane buffer.
export function createParticleCompute(d20Planes) {
    // Advance one particle, resolve D20 collisions, and respawn at the outer sphere.
    return wgslFn(`
        fn simulate_particle(position: vec3f, velocity: ptr<private, vec3f>, id: u32,
            initialize_particles: bool, frame_index: u32, delta_time: f32, min_speed: f32, max_speed: f32,
            d20_world_to_local: mat4x4f, prev_d20_world_to_local: mat4x4f, d20_local_to_world: mat4x4f) -> vec3f
        {
            var p = Particle(position, *velocity);
            if (initialize_particles)
            {
                p = spawn_particle(id, frame_index, min_speed, max_speed, true);
            }

            let prev_position = p.position;
            var next_position = prev_position + p.velocity * delta_time;
            
            let local_start = (prev_d20_world_to_local * vec4f(prev_position, 1.0f)).xyz;
            let local_end = (d20_world_to_local * vec4f(next_position, 1.0f)).xyz;
            let local_direction = local_end - local_start;
            let normal_matrix = transpose(mat3x3f(d20_world_to_local[0].xyz, d20_world_to_local[1].xyz, d20_world_to_local[2].xyz));
            var hit_time: f32;
            var local_normal: vec3f;
            var signed_distance: f32;

            if (intersect_segment_with_d20(local_start, local_direction, &hit_time, &local_normal))
            {
                let world_normal = local_normal_to_world(local_normal, normal_matrix);
                let collision_point = mix(prev_position, next_position, hit_time);

                p.velocity = bounce_velocity(p.velocity, world_normal);
                
                next_position = collision_point + world_normal * COLLISION_SKIN + p.velocity * (delta_time * (1.0f - hit_time));
            }

            let final_local_position = (d20_world_to_local * vec4f(next_position, 1.0f)).xyz;

            if (find_containing_face(final_local_position, &local_normal, &signed_distance))
            {
                let world_normal = local_normal_to_world(local_normal, normal_matrix);
                let local_surface = final_local_position - local_normal * signed_distance;

                p.velocity = bounce_velocity(p.velocity, world_normal);
                
                next_position = (d20_local_to_world * vec4f(local_surface, 1.0f)).xyz + world_normal * COLLISION_SKIN;
            }

            p.position = next_position;
            
            if (dot(p.position, p.position) >= MAX_SPAWN_DISTANCE * MAX_SPAWN_DISTANCE && dot(p.position, p.velocity) > 0.0f)
            {
                p = spawn_particle(id, frame_index, min_speed, max_speed, false);
            }
            
            *velocity = p.velocity;
            return p.position;
        }

        struct Particle
        {
            position: vec3f,
            velocity: vec3f,
        }

        const MIN_SPAWN_DISTANCE = 1.65f;
        const MAX_SPAWN_DISTANCE = 6.0f;
        const COLLISION_SKIN = 0.05f;
        const BOUNCINESS = 0.8f;

        // Hash an unsigned integer.
        fn hash(value: u32) -> u32
        {
            var x = ((value >> 16u) ^ value) * 73244475u;
            x = ((x >> 16u) ^ x) * 73244475u;
            return (x >> 16u) ^ x;
        }

        // Generate a random float from three seed values.
        fn generate_hashed_random_float(seed: vec3u) -> f32
        {
            let value = hash(seed.x ^ hash(seed.y ^ hash(seed.z)));
            return bitcast<f32>((value & 0x007fffffu) | 0x3f800000u) - 1.0f;
        }

        // Convert two uniform random values into a uniformly distributed unit direction.
        fn sample_sphere_uniform(u1: f32, u2: f32) -> vec3f
        {
            let phi = 6.28318530718f * u2;
            let cos_theta = 1.0f - 2.0f * u1;
            let sin_theta = sqrt(max(0.0f, 1.0f - cos_theta * cos_theta));
            return vec3f(sin_theta * cos(phi), sin_theta * sin(phi), cos_theta);
        }

        // Initialize a particle within the sphere or respawn it on the outer surface.
        fn spawn_particle(particle_id: u32, frame_index: u32, min_speed: f32, max_speed: f32, initialize: bool) -> Particle
        {
            let u1 = generate_hashed_random_float(vec3u(particle_id, frame_index, 0u));
            let u2 = generate_hashed_random_float(vec3u(particle_id, frame_index, 1u));
            let direction = sample_sphere_uniform(u1, u2);
            var speed = mix(min_speed, max_speed, generate_hashed_random_float(vec3u(particle_id, frame_index, 2u)));
            
            var distance = MAX_SPAWN_DISTANCE;
            if (initialize)
            {
                distance = mix(MIN_SPAWN_DISTANCE, MAX_SPAWN_DISTANCE, generate_hashed_random_float(vec3u(particle_id, frame_index, 3u)));
                speed *= select(1.0f, -BOUNCINESS, generate_hashed_random_float(vec3u(particle_id, frame_index, 4u)) < 0.5f);
            }

            return Particle(direction * distance, -direction * speed);
        }

        // Find where a local-space movement segment starting outside the D20 object intersects its surface.
        fn intersect_segment_with_d20(origin: vec3f, direction: vec3f, hit_time: ptr<function, f32>, local_normal: ptr<function, vec3f>) -> bool
        {
            *hit_time = 0.0f;
            *local_normal = vec3f(0.0f);
            var exit_time = 1.0f;

            for (var i = 0u; i < ${d20Planes.value.count}u; i++)
            {
                let plane = d20_planes.value[i];
                let distance = dot(plane.xyz, origin) + plane.w;
                let speed = dot(plane.xyz, direction);

                if (abs(speed) < 0.000001f)
                {
                    if (distance > 0.0f)
                    {
                        return false;
                    }

                    continue;
                }

                let plane_time = -distance / speed;

                if (speed < 0.0f)
                {
                    if (plane_time > *hit_time)
                    {
                        *hit_time = plane_time;
                        *local_normal = plane.xyz;
                    }
                }
                else if (plane_time < exit_time)
                {
                    exit_time = plane_time;
                }

                if (*hit_time > exit_time)
                {
                    return false;
                }
            }

            return *hit_time > 0.0f;
        }

        // Check if a local point is inside the D20 object; if so, output the nearest face normal and signed distance.
        fn find_containing_face(sample_position: vec3f, local_normal: ptr<function, vec3f>, signed_distance: ptr<function, f32>) -> bool
        {
            *local_normal = vec3f(0.0f);
            *signed_distance = -1.0e+30f;

            for (var i = 0u; i < ${d20Planes.value.count}u; i++)
            {
                let plane = d20_planes.value[i];
                let distance = dot(plane.xyz, sample_position) + plane.w;

                if (distance > 0.0f)
                {
                    return false;
                }

                if (distance > *signed_distance)
                {
                    *signed_distance = distance;
                    *local_normal = plane.xyz;
                }
            }

            return true;
        }

        // Transform a D20 object local-space normal to world space and normalize it.
        fn local_normal_to_world(local_normal: vec3f, normal_matrix: mat3x3f) -> vec3f
        {
            return normalize(normal_matrix * local_normal);
        }

        // Reflect inward velocity off the surface and apply bounciness.
        fn bounce_velocity(velocity: vec3f, world_normal: vec3f) -> vec3f
        {
            if (dot(velocity, world_normal) < 0.0f)
            {
                return reflect(velocity, world_normal) * BOUNCINESS;
            }
            return velocity;
        }
    `, [d20Planes]);
}
