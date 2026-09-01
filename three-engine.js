/**
 * ThreeEngine - Three.js 3Dグラフィック・マテリアル・パーティクル管理エンジン
 */
class ThreeEngine {
  constructor(canvasWidth = 1080, canvasHeight = 1920) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, canvasWidth / canvasHeight, 0.1, 1000);
    this.camera.position.set(0, 0, 5);

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setSize(512, 512);
    this.renderer.shadowMap.enabled = true;

    // ライティング初期化（シャドウマップ精度・軟調影の最適化）
    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    this.dirLight.position.set(3, 5, 4);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 1024;
    this.dirLight.shadow.mapSize.height = 1024;
    this.dirLight.shadow.camera.near = 0.5;
    this.dirLight.shadow.camera.far = 15;
    this.dirLight.shadow.bias = -0.001;
    this.scene.add(this.dirLight);

    // ★ 影だけを受け止める「透明な床 (Shadow Receiver)」を追加して奥行き感を劇的向上
    const floorGeo = new THREE.PlaneGeometry(10, 10);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    this.shadowFloor = new THREE.Mesh(floorGeo, floorMat);
    this.shadowFloor.position.y = -1.8;
    this.shadowFloor.rotation.x = -Math.PI / 2;
    this.shadowFloor.receiveShadow = true;
    this.scene.add(this.shadowFloor);

    this.pointLight = new THREE.PointLight(0x00f0ff, 0.8, 10);
    this.pointLight.position.set(-3, -2, 2);
    this.scene.add(this.pointLight);

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(this.ambientLight);

    const LoaderClass = window.GLTFLoader || (window.THREE && window.THREE.GLTFLoader);
    if (LoaderClass) {
      this.loader = new LoaderClass();
    }
  }

  // アスペクト比・解像度更新（ゼロ除算保護版）
  updateSize(width, height) {
    const safeW = Math.max(1, width || 1);
    const safeH = Math.max(1, height || 1);

    // ★ サイズ変更がない場合はスキップしてGPUオーバーヘッドをゼロ化
    if (this._lastW === safeW && this._lastH === safeH) return;
    this._lastW = safeW;
    this._lastH = safeH;

    this.camera.aspect = safeW / safeH;
    this.camera.updateProjectionMatrix();

    const maxDim = 1280;
    let renderW = safeW;
    let renderH = safeH;
    if (renderW > maxDim || renderH > maxDim) {
      const scale = maxDim / Math.max(renderW, renderH);
      renderW = Math.round(renderW * scale);
      renderH = Math.round(renderH * scale);
    }
    this.renderer.setSize(renderW, renderH, false);

    // リサイズ時に古いテクスチャバインディングキャッシュをパージ
    if (this.renderer.renderLists) {
      this.renderer.renderLists.dispose();
    }
  }

  // 3D基本形状（プリミティブ）の生成（平面板・星型・ハート・ピラミッド・コーン対応）
  createPrimitive(shapeType = 'cube', colorHex = '#00f0ff') {
    let geometry;
    let isDoubleSided = false;
    switch (shapeType) {
      case 'plane':
      case 'card':
        geometry = new THREE.PlaneGeometry(2.0, 1.3); // 16:9比率の3D板
        isDoubleSided = true;
        break;
      case 'cube':
        geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
        break;
      case 'sphere':
        geometry = new THREE.SphereGeometry(1, 32, 32);
        break;
      case 'torus':
        geometry = new THREE.TorusGeometry(0.9, 0.35, 16, 100);
        break;
      case 'cylinder':
        geometry = new THREE.CylinderGeometry(0.8, 0.8, 1.6, 32);
        break;
      case 'cone':
        geometry = new THREE.ConeGeometry(1.0, 1.8, 32);
        break;
      case 'pyramid':
        geometry = new THREE.ConeGeometry(1.2, 1.6, 4); // 四角錐
        break;
      case 'star': {
        const starShape = new THREE.Shape();
        const pts = 5;
        for (let i = 0; i < pts * 2; i++) {
          const l = i % 2 === 1 ? 0.45 : 1.0;
          const a = (i / (pts * 2)) * Math.PI * 2;
          const x = Math.cos(a) * l;
          const y = Math.sin(a) * l;
          if (i === 0) starShape.moveTo(x, y);
          else starShape.lineTo(x, y);
        }
        starShape.closePath();
        geometry = new THREE.ExtrudeGeometry(starShape, { depth: 0.35, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.08, bevelThickness: 0.08 });
        geometry.center(); // ★ 星の中心に回転軸を補正
        break;
      }
      case 'heart': {
        const heartShape = new THREE.Shape();
        const x = 0, y = 0;
        heartShape.moveTo(x + 0.25, y + 0.25);
        heartShape.bezierCurveTo(x + 0.25, y + 0.25, x + 0.20, y, x, y);
        heartShape.bezierCurveTo(x - 0.30, y, x - 0.30, y + 0.35, x - 0.30, y + 0.35);
        heartShape.bezierCurveTo(x - 0.30, y + 0.55, x - 0.10, y + 0.77, x + 0.25, y + 1.0);
        heartShape.bezierCurveTo(x + 0.60, y + 0.77, x + 0.80, y + 0.55, x + 0.80, y + 0.35);
        heartShape.bezierCurveTo(x + 0.80, y + 0.35, x + 0.80, y, x + 0.50, y);
        heartShape.bezierCurveTo(x + 0.35, y, x + 0.25, y + 0.25, x + 0.25, y + 0.25);
        geometry = new THREE.ExtrudeGeometry(heartShape, { depth: 0.3, bevelEnabled: true, bevelSegments: 3, steps: 1, bevelSize: 0.05, bevelThickness: 0.05 });
        geometry.center();
        break;
      }
      default:
        geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    }

    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      metalness: 0.4,
      roughness: 0.3,
      side: isDoubleSided ? THREE.DoubleSide : THREE.FrontSide
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // ★ 初期の奥行き・立体面がクッキリ見えるように少し斜めアングルに傾ける
    if (shapeType !== 'plane') {
      mesh.rotation.set(0.35, 0.45, 0); // X: 20度, Y: 25度傾けて3面を見せる
    }

    this.scene.add(mesh);
    return mesh;
  }

  // ★ ソフトな光の円形テクスチャを自動生成（クラス共通キャッシュ対応）
  createGlowTexture() {
    if (ThreeEngine._sharedGlowTexture) return ThreeEngine._sharedGlowTexture;

    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.3, 'rgba(255, 255, 255, 0.8)');
    grad.addColorStop(0.7, 'rgba(255, 255, 255, 0.2)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    ThreeEngine._sharedGlowTexture = new THREE.CanvasTexture(c);
    return ThreeEngine._sharedGlowTexture;
  }

  // ★ 3D物理パーティクルシステムの生成（10種類のプリセット完全対応）
  createParticleSystem(type = 'fire', count = 250) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    const lifeData = new Float32Array(count * 3); // x: 寿命周期, y: 位相ズレ, z: 個別サイズ

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      // 基準初期位置
      positions[idx] = (Math.random() - 0.5) * 5;
      positions[idx + 1] = (Math.random() - 0.5) * 5;
      positions[idx + 2] = (Math.random() - 0.5) * 3;

      // 寿命・位相
      lifeData[idx] = 1.5 + Math.random() * 2.0; // 寿命(秒)
      lifeData[idx + 1] = Math.random() * 10.0;   // 開始オフセット
      lifeData[idx + 2] = 0.5 + Math.random() * 0.8; // サイズ係数

      // プリセットごとの初期速度・カラープロファイル
      if (type === 'fire') { // 炎・火の粉
        velocities[idx] = (Math.random() - 0.5) * 0.8;
        velocities[idx + 1] = 1.8 + Math.random() * 1.5; // 上昇
        velocities[idx + 2] = (Math.random() - 0.5) * 0.8;
        colors[idx] = 1.0;
        colors[idx + 1] = 0.2 + Math.random() * 0.6; // 赤〜橙〜黄
        colors[idx + 2] = 0.05;
      } else if (type === 'snow') { // 雪
        velocities[idx] = (Math.random() - 0.5) * 0.3;
        velocities[idx + 1] = -(0.6 + Math.random() * 0.8); // ゆっくり降下
        velocities[idx + 2] = (Math.random() - 0.5) * 0.3;
        colors[idx] = 0.9; colors[idx + 1] = 0.95; colors[idx + 2] = 1.0;
      } else if (type === 'rain') { // 雨
        velocities[idx] = -0.2;
        velocities[idx + 1] = -(4.5 + Math.random() * 3.0); // 高速落下
        velocities[idx + 2] = 0.0;
        colors[idx] = 0.6; colors[idx + 1] = 0.8; colors[idx + 2] = 1.0;
      } else if (type === 'magic') { // 魔法・オーラ
        velocities[idx] = (Math.random() - 0.5) * 1.2;
        velocities[idx + 1] = (Math.random() - 0.5) * 1.2;
        velocities[idx + 2] = (Math.random() - 0.5) * 1.2;
        colors[idx] = 0.8 + Math.random() * 0.2; // マゼンタ〜シアン
        colors[idx + 1] = 0.1 + Math.random() * 0.8;
        colors[idx + 2] = 1.0;
      } else if (type === 'bubbles') { // 水中泡
        velocities[idx] = (Math.random() - 0.5) * 0.4;
        velocities[idx + 1] = 0.8 + Math.random() * 1.0; // 上昇
        velocities[idx + 2] = (Math.random() - 0.5) * 0.4;
        colors[idx] = 0.3; colors[idx + 1] = 0.9; colors[idx + 2] = 1.0;
      } else if (type === 'sparks') { // 火花
        const angle = Math.random() * Math.PI * 2;
        const speed = 1.5 + Math.random() * 2.5;
        velocities[idx] = Math.cos(angle) * speed;
        velocities[idx + 1] = Math.sin(angle) * speed;
        velocities[idx + 2] = (Math.random() - 0.5) * speed;
        colors[idx] = 1.0; colors[idx + 1] = 0.6 + Math.random() * 0.4; colors[idx + 2] = 0.1;
      } else if (type === 'smoke') { // 煙・モヤ
        velocities[idx] = (Math.random() - 0.5) * 0.3;
        velocities[idx + 1] = 0.4 + Math.random() * 0.5;
        velocities[idx + 2] = (Math.random() - 0.5) * 0.3;
        const g = 0.6 + Math.random() * 0.3;
        colors[idx] = g; colors[idx + 1] = g; colors[idx + 2] = g;
      } else if (type === 'confetti') { // 紙吹雪
        velocities[idx] = (Math.random() - 0.5) * 0.8;
        velocities[idx + 1] = -(0.8 + Math.random() * 1.0);
        velocities[idx + 2] = (Math.random() - 0.5) * 0.8;
        colors[idx] = Math.random(); colors[idx + 1] = Math.random(); colors[idx + 2] = Math.random();
      } else { // stars / cyber
        velocities[idx] = 0; velocities[idx + 1] = 0; velocities[idx + 2] = 1.5;
        colors[idx] = 0.4 + Math.random() * 0.6;
        colors[idx + 1] = 0.8 + Math.random() * 0.2;
        colors[idx + 2] = 1.0;
      }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('velocity', new THREE.BufferAttribute(velocities, 3));
    geometry.setAttribute('lifeData', new THREE.BufferAttribute(lifeData, 3));

    // 発光・加算ブレンド対応マテリアル
    const isAdditive = ['fire', 'magic', 'sparks', 'stars', 'bubbles'].includes(type);
    const material = new THREE.PointsMaterial({
      size: type === 'smoke' ? 0.25 : (type === 'rain' ? 0.05 : 0.12),
      map: this.createGlowTexture(),
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: isAdditive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false
    });

    const points = new THREE.Points(geometry, material);
    points.userData = { particleType: type, basePositions: new Float32Array(positions) };
    this.scene.add(points);
    return points;
  }
// ★ シーク（時間移動）完全同期のリアルタイム物理アニメーション
  updateParticleSystem(points, relTime, speedMult = 1.0) {
    if (!points || !points.geometry || !points.geometry.attributes.position || !points.userData) return;

    const geo = points.geometry;
    const pos = geo.attributes.position.array;
    const basePos = points.userData.basePositions;
    const vel = geo.attributes.velocity ? geo.attributes.velocity.array : null;
    const life = geo.attributes.lifeData ? geo.attributes.lifeData.array : null;
    const count = pos.length / 3;
    const type = points.userData.particleType || 'fire';

    if (!basePos || !vel || !life) return;

    const validSpeed = isFinite(speedMult) ? Math.max(0.1, speedMult) : 1.0;
    const t = (isFinite(relTime) ? Math.max(0, relTime) : 0) * validSpeed;

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const period = Math.max(0.1, isFinite(life[idx]) ? life[idx] : 2.0);
      const offset = isFinite(life[idx + 1]) ? life[idx + 1] : 0;
      const rawProgress = ((t + offset) % period) / period;
      const progress = isNaN(rawProgress) ? 0 : Math.max(0, Math.min(1, rawProgress));
      const aliveTime = progress * period;

      if (type === 'fire') { // 炎: 上昇 + 上部に向かって中心へすぼまる
        pos[idx] = basePos[idx] * (1.0 - progress * 0.7) + Math.sin(aliveTime * 6.0 + offset) * 0.15;
        pos[idx + 1] = -1.8 + (aliveTime * vel[idx + 1]);
        pos[idx + 2] = basePos[idx + 2] * (1.0 - progress * 0.7);
      } else if (type === 'snow') { // 雪: ゆらゆら左右に揺れながら降下
        pos[idx] = basePos[idx] + Math.sin(aliveTime * 1.5 + offset) * 0.4;
        pos[idx + 1] = 2.5 - ((basePos[idx + 1] + aliveTime * Math.abs(vel[idx + 1])) % 5.0);
        pos[idx + 2] = basePos[idx + 2] + Math.cos(aliveTime * 1.2 + offset) * 0.2;
      } else if (type === 'rain') { // ★ 雨: 雨脚ストリーク + 地面水しぶき (スプラッシュ)
        const fallDist = (aliveTime * Math.abs(vel[idx + 1])) % 6.0;
        const currentY = 3.0 - fallDist;

        // 地面付近（Y < -2.2）に達した粒子は左右に弾ける水しぶきに変化
        if (currentY < -2.2) {
          const splashTime = (aliveTime * 8.0) % 1.0;
          pos[idx] = basePos[idx] + (Math.sin(offset * 10.0) * splashTime * 0.4);
          pos[idx + 1] = -2.3 + Math.sin(splashTime * Math.PI) * 0.25; // ピシャッと跳ねる
          pos[idx + 2] = basePos[idx + 2] + (Math.cos(offset * 10.0) * splashTime * 0.4);
        } else {
          pos[idx] = basePos[idx] + Math.sin(aliveTime * 2.0 + offset) * 0.1 - 0.2 * progress; // 周期的な風揺れ
          pos[idx + 1] = currentY;
          pos[idx + 2] = basePos[idx + 2];
        }
      } else if (type === 'magic') { // 魔法: スパイラル回転しながら拡散
        const angle = aliveTime * 3.5 + offset;
        const radius = 0.2 + progress * 2.2;
        pos[idx] = Math.cos(angle) * radius;
        pos[idx + 1] = Math.sin(aliveTime * 2.0 + offset) * 1.5;
        pos[idx + 2] = Math.sin(angle) * radius;
      } else if (type === 'bubbles') { // 泡: 上昇と小刻みなサイン揺れ
        pos[idx] = basePos[idx] + Math.sin(aliveTime * 4.0 + offset) * 0.18;
        pos[idx + 1] = -2.2 + (aliveTime * vel[idx + 1]) % 4.5;
        pos[idx + 2] = basePos[idx + 2] + Math.cos(aliveTime * 3.0 + offset) * 0.18;
      } else if (type === 'sparks') { // 火花: 放物線重力落下
        pos[idx] = vel[idx] * aliveTime;
        pos[idx + 1] = (vel[idx + 1] * aliveTime) - (4.9 * aliveTime * aliveTime * 0.5); // 重力加速度
        pos[idx + 2] = vel[idx + 2] * aliveTime;
      } else if (type === 'confetti') { // 紙吹雪: ヒラヒラ回転降下
        pos[idx] = basePos[idx] + Math.sin(aliveTime * 3.0 + offset) * 0.5;
        pos[idx + 1] = 2.8 - (aliveTime * Math.abs(vel[idx + 1])) % 5.6;
        pos[idx + 2] = basePos[idx + 2] + Math.cos(aliveTime * 2.5 + offset) * 0.5;
      } else if (type === 'smoke') { // 煙: 膨張しながら立ち上る
        pos[idx] = basePos[idx] * (1.0 + progress * 2.0);
        pos[idx + 1] = -1.5 + (aliveTime * vel[idx + 1]);
        pos[idx + 2] = basePos[idx + 2] * (1.0 + progress * 2.0);
      } else { // stars: 宇宙ワープ (奥から手前へ連続ループ)
        pos[idx] = basePos[idx];
        pos[idx + 1] = basePos[idx + 1];
        pos[idx + 2] = -3.0 + ((basePos[idx + 2] + aliveTime * 2.5 + 6.0) % 6.0);
      }
    }

    geo.attributes.position.needsUpdate = true;
  }
  // GLTF / GLB / VRM モデルのロード (VRM 3.0 & ボーン・アニメーション完全バインド)
  loadGLTF(url) {
    return new Promise((resolve, reject) => {
      const LoaderClass = window.GLTFLoader || (window.THREE && window.THREE.GLTFLoader);
      const loader = LoaderClass ? new LoaderClass() : this.loader;

      // VRMプラグインの登録
      if (window.VRMLoaderPlugin) {
        loader.register((parser) => new window.VRMLoaderPlugin(parser));
      }

      loader.load(
        url,
        (gltf) => {
          const vrm = gltf.userData.vrm;
          const model = vrm ? vrm.scene : gltf.scene;
          let mixer = null;

          if (vrm && window.VRMUtils?.rotateVRM0) {
            window.VRMUtils.rotateVRM0(vrm);
          }

          if (gltf.animations && gltf.animations.length > 0) {
            mixer = new window.THREE.AnimationMixer(model);
            gltf.animations.forEach((clip) => {
              mixer.clipAction(clip).play();
            });
            model.animations = gltf.animations;
          }

          // VRMの場合は影と初期回転を設定
          model.traverse((obj) => {
            if (obj.isMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
            }
          });

          this.scene.add(model);
          resolve({ model, mixer, vrm });
        },
        undefined,
        (err) => reject(err)
      );
    });
  }

  // 3Dマテリアル・全属性のリアルタイム適用 (グラデーションテクスチャ・全立体メッシュ完全対応)
  applyMaterialProps(model, props) {
    if (!model || !props) return;
    const {
      color,
      metalness = 0.5,
      roughness = 0.5,
      wireframe = false,
      shaderType = 'standard',
      opacity = 1.0,
      emissiveIntensity = 0.5,
      particleSize = 0.08,
      gradientEnabled = false,
      gradientColor1 = '#00f0ff',
      gradientColor2 = '#7928ca'
    } = props;

    // 動的グラデーションテクスチャの生成・キャッシュ
    let gradTexture = null;
    if (gradientEnabled) {
      const gradKey = `grad_${gradientColor1}_${gradientColor2}`;
      if (!this._textureCache) this._textureCache = new Map();

      if (this._textureCache.has(gradKey)) {
        gradTexture = this._textureCache.get(gradKey);
      } else {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = 128;
        offCanvas.height = 128;
        const ctx = offCanvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 128, 128);
        grad.addColorStop(0, gradientColor1);
        grad.addColorStop(1, gradientColor2);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 128, 128);

        gradTexture = new THREE.CanvasTexture(offCanvas);
        gradTexture.needsUpdate = true;
        this._textureCache.set(gradKey, gradTexture);
      }
    }

    model.traverse((child) => {
      // 1. パーティクル (Points) への全設定適用
      if (child.isPoints && child.material) {
        if (color) {
          child.material.color.setStyle(color);
          if (child.material.vertexColors) {
            child.material.vertexColors = false;
            child.material.needsUpdate = true;
          }
        }
        child.material.size = Math.max(0.01, particleSize);
        child.material.transparent = true;
        child.material.opacity = Math.max(0.0, Math.min(1.0, opacity));

        if (shaderType === 'neon') {
          child.material.size = Math.max(0.01, particleSize * 1.5);
          child.material.opacity = 1.0;
        } else if (shaderType === 'glass') {
          child.material.opacity = Math.min(0.5, opacity);
        }
        child.material.needsUpdate = true;
      }

      // 2. 通常メッシュ (Mesh) への全設定適用 (GLTFモデルを含む)
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];

        mats.forEach((mat) => {
          if (gradientEnabled && gradTexture) {
            mat.map = gradTexture;
            mat.color.setStyle('#ffffff'); // テクスチャ色をそのまま発色
          } else {
            mat.map = null;
            if (color) mat.color.setStyle(color);
          }

          mat.transparent = opacity < 1.0 || shaderType === 'glass';
          mat.opacity = Math.max(0.0, Math.min(1.0, opacity));

          // ★ 安全なカラーインスタンス生成ヘルパー
          const safeColor = (c, defaultHex) => {
            try { return new THREE.Color(c || defaultHex); } 
            catch (e) { return new THREE.Color(defaultHex); }
          };

          if (shaderType === 'neon') {
            if ('emissive' in mat) mat.emissive = safeColor(color, '#00f0ff');
            if ('emissiveIntensity' in mat) mat.emissiveIntensity = emissiveIntensity * 2.0;
            if ('roughness' in mat) mat.roughness = 0.1;
            if ('metalness' in mat) mat.metalness = 0.1;
          } else if (shaderType === 'glass') {
            if ('emissive' in mat) mat.emissive = new THREE.Color(0x000000);
            mat.transparent = true;
            mat.opacity = Math.min(0.55, opacity);
            if ('roughness' in mat) mat.roughness = 0.05;
            if ('metalness' in mat) mat.metalness = 0.9;
          } else {
            if ('emissive' in mat) {
              mat.emissive = emissiveIntensity > 0 ? safeColor(color, '#000000') : new THREE.Color(0x000000);
              mat.emissiveIntensity = emissiveIntensity;
            }
            if ('metalness' in mat) mat.metalness = metalness;
            if ('roughness' in mat) mat.roughness = roughness;
          }

          if ('wireframe' in mat) mat.wireframe = !!wireframe;
          mat.needsUpdate = true;
        });
      }
    });
  }

  // モデルのメモリ安全な破棄 (GPU VRAM & 頂点バッファ完全解放版)
  disposeModel(model) {
    if (!model) return;
    this.scene.remove(model);

    model.traverse((child) => {
      // 1. ジオメトリの解放
      if (child.geometry) {
        if (typeof child.geometry.dispose === 'function') {
          child.geometry.dispose();
        }
      }

      if (child.userData) {
        child.userData.basePositions = null;
      }

      // 2. マテリアル & テクスチャの完全解放
      if (child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach((m) => {
          ['map', 'lightMap', 'bumpMap', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap'].forEach((prop) => {
            if (m[prop] && typeof m[prop].dispose === 'function') {
              let isShared = false;
              if (this._textureCache) {
                for (const tex of this._textureCache.values()) {
                  if (tex === m[prop]) { isShared = true; break; }
                }
              }
              if (m[prop] === ThreeEngine._sharedGlowTexture) isShared = true;
              if (!isShared) {
                try { m[prop].dispose(); } catch (e) {}
              }
            }
          });
          try { m.dispose(); } catch (e) {}
        });
      }
    });
  }

  // 1フレームのレンダリング（深度・カラーバッファの完全クリア版）
  render() {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
  }

  getDomElement() {
    return this.renderer.domElement;
  }
}

window.ThreeEngine = ThreeEngine;