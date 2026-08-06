import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * 场景 / 相机 / 轨道控制 / Bloom 后期。
 * 相机默认缓慢自动环绕，鼠标与触摸可旋转缩放。
 */
export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly pixelRatio: number;

  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private resizeHandler: () => void;

  constructor(canvas: HTMLCanvasElement, bloomEnabled: boolean) {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x050508, 1);
    // 显式 sRGB 输出 + 电影感色调映射：高光滚降自然，配合亮度上限杜绝死白
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.7;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x050508);

    this.camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / window.innerHeight,
      0.1,
      2000
    );

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.11; // 缓慢环绕，镜头以观察为主
    this.controls.minDistance = 12;
    this.controls.maxDistance = 600;

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.pixelRatio);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.35, // strength：克制，只有高亮恒星层轻微泛光
      0.35, // radius
      0.65 // threshold：光雾层与普通星体层不参与
    );
    this.bloomPass.enabled = bloomEnabled;
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.resizeHandler = () => this.resize();
    window.addEventListener('resize', this.resizeHandler);
  }

  /** 根据预设调整相机（轻微俯视，突出盘的立体感） */
  frameCamera(distance: number): void {
    this.camera.position.set(distance * 0.32, distance * 0.42, distance * 0.86);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /**
   * Art Preview 构图：相对盘面倾斜约 25°，银河占画面约 70%，
   * 中心略偏画面中心，大面积纯黑留白。
   */
  frameArtCamera(): void {
    const dist = 68;
    const elev = (25 * Math.PI) / 180;
    const azim = (28 * Math.PI) / 180;
    this.camera.position.set(
      dist * Math.cos(elev) * Math.sin(azim),
      dist * Math.sin(elev),
      dist * Math.cos(elev) * Math.cos(azim)
    );
    // 视点中心略微偏离银河核心
    this.controls.target.set(2.5, 0, 2.0);
    this.controls.update();
  }

  /**
   * Vortex Energy 取景：正面略俯视（12°）能量球，球体占画面高约 64%。
   * 压缩模型下可见结构集中在 ~0.6R 内，距离收到 2.2R 保持构图饱满。
   * azimDeg=90 时给出正侧面视角（验收截图用）。
   */
  frameVortexCamera(radius: number, azimDeg = 28): void {
    const dist = radius * 2.0;
    const elev = (12 * Math.PI) / 180;
    const azim = (azimDeg * Math.PI) / 180;
    this.camera.position.set(
      dist * Math.cos(elev) * Math.sin(azim),
      dist * Math.sin(elev),
      dist * Math.cos(elev) * Math.cos(azim)
    );
    this.controls.target.set(0, 0, 0);
    this.controls.autoRotateSpeed = 0.06; // 缓慢漂移，不高速旋转
    this.controls.update();
  }

  setBloom(enabled: boolean): void {
    this.bloomPass.enabled = enabled;
  }

  /** 按引擎调 Bloom 风格（galaxy 克制 / vortex 宽软能量光晕） */
  setBloomParams(strength: number, radius: number, threshold: number): void {
    this.bloomPass.strength = strength;
    this.bloomPass.radius = radius;
    this.bloomPass.threshold = threshold;
  }

  /** 曝光按引擎调整（galaxy 0.7 克制 / vortex 更亮更有能量感） */
  setExposure(v: number): void {
    this.renderer.toneMappingExposure = v;
  }

  render(): void {
    this.controls.update();
    this.composer.render();
  }

  /** resize 时通知外部（LineMaterial.resolution 等需要视口尺寸的材质） */
  onResize: ((width: number, height: number) => void) | null = null;

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.onResize?.(w, h);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resizeHandler);
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
