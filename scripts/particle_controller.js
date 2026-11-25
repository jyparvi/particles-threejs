import * as THREE from 'three/webgpu';
import {
    Fn, attribute, attributeArray, cameraProjectionMatrix, cameraViewMatrix, color, diffuseColor,
    instanceIndex, instancedArray, pass, positionGeometry, reference, renderOutput,
    screenCoordinate, uniform, varyingProperty, vec4
} from 'three/tsl';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createParticleCompute } from '../shaders/particle_compute.js';
import { createParticleVertex, particleFragment } from '../shaders/particle_render.js';
import { filmGrain } from '../shaders/film_grain.js';

if (!navigator.gpu)
{
    throw new Error("WebGPU is required");
}

const settings = {
    particleCount: 500,
    particleSize: 0.05,
    minSpeed: 1.0,
    maxSpeed: 4.0,
    velocityStretch: 0.04,
    rotationSpeed: { x: 10.0, y: 15.0, z: 10.0 },
    nearParticleColor: '#ff0000',
    farParticleColor: '#ffff00',
    enableGlow: true,
    glowColor: '#ffffff',
    glowIntensity: 4.0,
    glowSharpness: 2.0,
    bloomAmount: 1.0,
    filmGrainAmount: 0.5
};

const param = name => reference(name, 'float', settings);
const hud = document.getElementById('hud');

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
await renderer.init();
if (!renderer.backend.isWebGPUBackend)
{
    renderer.dispose();
    throw new Error("WebGPU could not initialize.");
}
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0x99abd1, 0x454952, 0.75));
const light = new THREE.DirectionalLight(0xffffff, 2.0);
light.position.set(0.3214, 0.7660, 0.5567);
scene.add(light);

const camera = new THREE.PerspectiveCamera(60.0, window.innerWidth / window.innerHeight, 1.0, 12.0);
camera.position.z = 5.0;

const textureLoader = new THREE.TextureLoader();
const d20Texture = await textureLoader.loadAsync('./textures/d20.png');
const sphereTexture = await textureLoader.loadAsync('./textures/sphere.png');
d20Texture.colorSpace = THREE.SRGBColorSpace;
sphereTexture.colorSpace = THREE.SRGBColorSpace;

const d20Model = await new FBXLoader().loadAsync('./models/d20.fbx');
const d20Geometry = d20Model.getObjectByProperty('isMesh', true).geometry;
d20Geometry.scale(0.01, 0.01, 0.01);
const d20Mesh = new THREE.Mesh(d20Geometry, new THREE.MeshStandardNodeMaterial({
    map: d20Texture, roughness: 0.5,
    emissiveNode: diffuseColor.rgb.mul(color(0x99abd1), 0.12),
}));
d20Mesh.rotation.x = Math.PI * 0.5;

scene.add(d20Mesh);
scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(6.0, 64, 32).rotateY(Math.PI * 0.5),
    new THREE.MeshStandardNodeMaterial({
        map: sphereTexture, roughness: 0.5, side: THREE.DoubleSide,
        emissiveNode: diffuseColor.rgb.mul(color(0x99abd1), 0.4),
    }),
));

const d20Planes = buildD20Planes(d20Geometry);
const particleCompute = createParticleCompute(d20Planes);
const particleVertex = createParticleVertex(d20Planes);

d20Mesh.updateMatrixWorld();
const worldToLocal = uniform(d20Mesh.matrixWorld.clone().invert());
const previousWorldToLocal = uniform(new THREE.Matrix4());
const localToWorld = uniform(d20Mesh.matrixWorld);

const deltaTime = uniform(0.0);
const frame = uniform(0, 'uint');
const initialize = uniform(false);
const nearColor = uniform(new THREE.Color(settings.nearParticleColor));
const farColor = uniform(new THREE.Color(settings.farParticleColor));
const glowColor = uniform(new THREE.Color(settings.glowColor));
const glowIntensity = uniform(settings.glowIntensity);
let particles;
let compute;
rebuildParticles();

const pipeline = new THREE.RenderPipeline(renderer);
pipeline.outputColorTransform = false;
const sceneColor = pass(scene, camera).getTextureNode('output');
const bloomPass = bloom(sceneColor, param('bloomAmount').mul(0.2), 0.0, 1.0);
updatePostProcessing();

const gui = new GUI();
gui.$title.outerHTML = '<h2>Particles</h2>';
gui.add(settings, 'particleCount', 1, 1000000, 1).name('Particle Count').onFinishChange(rebuildParticles);
gui.add(settings, 'particleSize', 0.001, 1.0, 0.001).name('Particle Size');
gui.add(settings, 'minSpeed', 0.0, 10.0, 0.1).name('Min Speed');
gui.add(settings, 'maxSpeed', 0.0, 10.0, 0.1).name('Max Speed');
gui.add(settings, 'velocityStretch', 0.0, 0.5, 0.001).name('Velocity Stretch');
gui.$children.insertAdjacentHTML('beforeend', '<h2>D20 Rotation Speed</h2>');
gui.add(settings.rotationSpeed, 'x', -180.0, 180.0, 1.0);
gui.add(settings.rotationSpeed, 'y', -180.0, 180.0, 1.0);
gui.add(settings.rotationSpeed, 'z', -180.0, 180.0, 1.0);
gui.addColor(settings, 'nearParticleColor').name('Near Particle Color').onChange(value => nearColor.value.set(value));
gui.addColor(settings, 'farParticleColor').name('Far Particle Color').onChange(value => farColor.value.set(value));

const glow = gui.addFolder('Glow');
glow.add(settings, 'enableGlow').name('Enable Glow');
glow.addColor(settings, 'glowColor').name('Glow Color').onChange(value => glowColor.value.set(value));
glow.add(settings, 'glowIntensity', 0.0, 10.0, 0.01).name('Glow Intensity');
glow.add(settings, 'glowSharpness', 0.25, 8.0, 0.01).name('Glow Sharpness');

const post = gui.addFolder('Post Processing');
post.add(settings, 'bloomAmount', 0.0, 10.0, 0.01).name('Bloom Amount').onFinishChange(updatePostProcessing);
post.add(settings, 'filmGrainAmount', 0.0, 1.0, 0.01).name('Film Grain Amount');

const axes = [new THREE.Vector3(0.0, 0.0, 1.0), new THREE.Vector3(1.0, 0.0, 0.0), new THREE.Vector3(0.0, 1.0, 0.0)];
let previousTime = performance.now();
renderer.setAnimationLoop(updateFrame);
window.addEventListener('resize', resize);

// Rotate the D20 object, dispatch the particle simulation, and render the frame.
function updateFrame(time)
{
    const elapsed = Math.max((time - previousTime) * 0.001, 0.0);
    previousTime = time;
    deltaTime.value = Math.min(elapsed, 0.05);
    previousWorldToLocal.value.copy(worldToLocal.value);

    const radians = THREE.MathUtils.degToRad(deltaTime.value);
    d20Mesh.rotateOnWorldAxis(axes[0], settings.rotationSpeed.z * radians);
    d20Mesh.rotateOnWorldAxis(axes[1], -settings.rotationSpeed.x * radians);
    d20Mesh.rotateOnWorldAxis(axes[2], -settings.rotationSpeed.y * radians);
    d20Mesh.updateMatrixWorld();
    
    worldToLocal.value.copy(d20Mesh.matrixWorld).invert();
    glowIntensity.value = settings.enableGlow ? settings.glowIntensity : 0.0;
 
    renderer.compute(compute);
    pipeline.render();
    
    const fps = Math.round(1.0 / Math.max(elapsed, 0.0001));
    hud.textContent = `Particles: ${particles.geometry.instanceCount.toLocaleString()}\nFPS: ${fps}`;

    frame.value = (frame.value + 1) >>> 0;
    initialize.value = false;
}

// Recreate the particle buffers and bind them to the compute shader and billboard mesh.
function rebuildParticles()
{
    if (particles)
    {
        scene.remove(particles);
        particles.geometry.dispose();
        particles.material.dispose();
        compute.dispose();
    }
    
    const positions = instancedArray(settings.particleCount, 'vec4');
    const velocities = instancedArray(settings.particleCount, 'vec4');
    
    compute = Fn(() =>
    {
        const velocity = velocities.element(instanceIndex).xyz.toVar();
        const position = particleCompute({
            position: positions.element(instanceIndex).xyz,
            velocity, id: instanceIndex, initialize_particles: initialize, frame_index: frame, delta_time: deltaTime,
            min_speed: param('minSpeed'), max_speed: param('maxSpeed'),
            d20_world_to_local: worldToLocal, prev_d20_world_to_local: previousWorldToLocal,
            d20_local_to_world: localToWorld,
        }).toVar();
        positions.element(instanceIndex).assign(vec4(position, 0.0));
        velocities.element(instanceIndex).assign(vec4(velocity, 0.0));
    })().compute(settings.particleCount, [256]);

    const geometry = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(2.0, 2.0));
    geometry.instanceCount = settings.particleCount;
    geometry.setAttribute('particlePosition', positions.value);
    geometry.setAttribute('particleVelocity', velocities.value);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const particleColor = varyingProperty('vec4');
    const particleUV = varyingProperty('vec2');
    
    material.vertexNode = Fn(() =>
    {
        const vertex = particleVertex({
            world_position: attribute('particlePosition', 'vec4').xyz,
            velocity: attribute('particleVelocity', 'vec4').xyz,
            corner: positionGeometry.xy,
            view_matrix: cameraViewMatrix, projection_matrix: cameraProjectionMatrix,
            particle_size: param('particleSize'), velocity_stretch: param('velocityStretch'),
            d20_world_to_local: worldToLocal,
            near_particle_color: vec4(nearColor, 1.0),
            far_particle_color: vec4(farColor, 1.0),
        }).toVar();
        particleColor.assign(vertex.get('particle_color'));
        particleUV.assign(vertex.get('uv'));
        return vertex.get('position');
    })();
    
    material.fragmentNode = particleFragment({
        particle_color: particleColor, uv: particleUV,
        glow_color: glowColor, glow_intensity: glowIntensity, glow_sharpness: param('glowSharpness'),
    });
    
    particles = new THREE.Mesh(geometry, material);
    particles.frustumCulled = false;
    scene.add(particles);
    
    initialize.value = true;
}

// Build normalized outward planes in the D20 object's local space.
function buildD20Planes(geometry)
{
    const vertices = geometry.attributes.position;
    const planeCount = vertices.count / 3;
    const d20Planes = attributeArray(planeCount, 'vec4').toReadOnly().setName('d20_planes');
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();

    for (let i = 0; i < vertices.count; i += 3)
    {
        a.fromBufferAttribute(vertices, i);
        b.fromBufferAttribute(vertices, i + 1).sub(a);
        c.fromBufferAttribute(vertices, i + 2).sub(a);
        const normal = b.cross(c);

        normal.normalize();
        if (normal.dot(a) < 0.0)
        {
            normal.negate();
        }
    
        d20Planes.value.setXYZW(i / 3, normal.x, normal.y, normal.z, -normal.dot(a));
    }
    return d20Planes;
}

// Apply film grain and include bloom when its amount is nonzero.
function updatePostProcessing()
{
    pipeline.outputNode = filmGrain({
        color: renderOutput(settings.bloomAmount > 0.0 ? sceneColor.add(bloomPass) : sceneColor).rgb,
        screen_pixel: screenCoordinate, frame_index: frame, film_grain_amount: param('filmGrainAmount'),
    });
    pipeline.needsUpdate = true;
}

// Update the camera projection and renderer size to match the window.
function resize()
{
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
}
