/**
 * AvatarStudioEngine - 2Dドット絵 & 3D VRM リアルタイムトラッキング・アバタースタジオ (完全網羅版)
 */
class AvatarStudioEngine {
  constructor(editor) {
    this.editor = editor;
    this.isActive = false;

    // 描画関連
    this.canvas = null;
    this.ctx = null;
    this.vrmCanvas = document.createElement('canvas');
    this.vrmRenderer = null;
    this.vrmScene = null;
    this.vrmCamera = null;
    this.vrmControls = null;
    this.currentVrm = null;
    this.vrmClock = null;

    // 2Dドット絵関連
    this.layers = [];
    this.currentAppMode = '2d'; // '2d' | 'vrm'
    this.CANVAS_W = 1280;
    this.CANVAS_H = 720;
    this.original2DWidth = 640;
    this.original2DHeight = 320;

    // 背景関連
    this.currentBgColor = '#00ff00';
    this.bgImage = null;
    this.bgVideo = null;
    this.currentBgUrl = null;

    // 配置
    this.currentAlignX = 'center';
    this.currentAlignY = 'center';
    this.currentResolutionType = 'landscape';

    // ライティング
    this.vrmDirectionalLight = null;
    this.vrmSpotLight1 = null;
    this.vrmSpotLight2 = null;
    this.vrmAmbientLight = null;

    // トラッキング・AI関連
    this.videoElement = null;
    this.faceLandmarker = null;
    this.poseLandmarker = null;
    this.handLandmarker = null;
    this.isCameraActive = false;
    this.isMicOnlyActive = false;
    this.currentFacingMode = 'user';
    this.lastVideoTime = -1;
    this.videoAnimId = null;
    this.frameSkipCounter = 0;

    // パラメータ・姿勢
    this.live2dParams = { angleX: 0, angleY: 0, angleZ: 0, eyeL: 0, eyeR: 0, mouth: 0, aiA: 0, aiI: 0, aiU: 0 };
    this.faceOffset = { angleX: 0, angleY: 0, angleZ: 0 };
    this.lastRawRot = { x: 0, y: 0, z: 0 };
    this.expressionOffset = { angleX: 0, angleY: 0, angleZ: 0, eyeL: 0, eyeR: 0, mouth: 0, opacity: 0 };
    this.physicsState = { x: 0, y: 0, vx: 0, vy: 0 };
    this.smoothMouth = { aa: 0, ih: 0, ou: 0 };
    this.smoothPose = { lArm: 0, rArm: 0, lFore: 0, rFore: 0, lLeg: 0, rLeg: 0 };
    this.poseData = { lArm: 0, rArm: 0, lFore: 0, rFore: 0, lLeg: 0, rLeg: 0, lVis: false, rVis: false, legVis: false };
    this.handState = { leftGrip: 0, rightGrip: 0 };
    this.blinkValue = 0;
    this.micLevel = 0;
    this.randomGazeX = 0;
    this.randomGazeY = 0;
    this.gazeTimer = 0;

    // VRM制御
    this.currentCameraMode = 'bustup';
    this.vrmBones = { head: null, neck: null, spine: null, chest: null, hips: null, lArm: null, rArm: null, lFore: null, rFore: null, lHand: null, rHand: null, lLeg: null, rLeg: null };
    this.manualExpressions = {};
    this.activeVRMEmotion = '';
    this.vrmEmotionShortcuts = { '1': '' };
    this.emotionPresets = {};
    this.vrmMixer = null;
    this.currentAction = null;
    this.isAnimationPlaying = false;
    this.activePresetPose = null;
    this.loadedMotionClips = [];

    // 音声・ボイスチェンジャー
    this.pitchShifterCode = `
      class PitchShifterProcessor extends AudioWorkletProcessor {
        constructor(options) {
          super();
          const sr = (options && options.processorOptions && options.processorOptions.sampleRate) || 48000;
          this.delayBuffer = new Float32Array(Math.floor(sr * 2));
          this.writePos = 0;
          this.pitchRatio = 1.0;
          this.readPos1 = 0;
          this.windowSize = Math.floor(sr * 0.05);
          this.readPos2 = this.windowSize / 2;
          this.port.onmessage = (e) => {
            if (e.data.pitchRatio !== undefined) this.pitchRatio = e.data.pitchRatio;
          };
        }
        process(inputs, outputs) {
          const input = inputs[0][0];
          const output = outputs[0][0];
          if (!input || !output) return true;
          for (let i = 0; i < input.length; i++) {
            this.delayBuffer[this.writePos] = input[i];
            this.readPos1 += this.pitchRatio;
            this.readPos2 += this.pitchRatio;
            if (this.readPos1 >= this.windowSize) this.readPos1 -= this.windowSize;
            if (this.readPos2 >= this.windowSize) this.readPos2 -= this.windowSize;
            let idx1 = Math.floor(this.writePos - this.readPos1);
            if (idx1 < 0) idx1 += this.delayBuffer.length;
            let idx2 = Math.floor(this.writePos - this.readPos2);
            if (idx2 < 0) idx2 += this.delayBuffer.length;
            let fade1 = 1.0 - Math.abs((this.readPos1 - this.windowSize/2) / (this.windowSize/2));
            let fade2 = 1.0 - Math.abs((this.readPos2 - this.windowSize/2) / (this.windowSize/2));
            output[i] = (this.delayBuffer[idx1] * fade1 + this.delayBuffer[idx2] * fade2);
            this.writePos++;
            if (this.writePos >= this.delayBuffer.length) this.writePos = 0;
          }
          return true;
        }
      }
      registerProcessor('pitch-shifter', PitchShifterProcessor);
    `;
    this.micSource = null;
    this.pitchNode = null;
    this.monitorGain = null;
    this.recordGain = null;
    this.recordDestination = null;
    this.analyser = null;
    this.dataArray = null;

    // 録画関連
    this.isRecording = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];

    // OBSウィンドウ
    this.currentObsWindow = null;
    this.obsAnimId = null;

    // レンダリングループ制御
    this.renderLoopAnimId = null;
    this.isLoopRunning = false;

    // 補間一時オブジェクト & 再利用バッファ（GC削減）
    this._tempS0 = {};
    this._tempSv = {};
    this._tempRes = {};
    this._renderFinalParams = {};
    this._motionOffsetCache = { angleX: 0, angleY: 0, eyeL: 0, eyeR: 0, mouth: 0 };
    this._vrmCameraWorldPos = null;
    this._poseTgtBuffer = { lArm: 1.2, rArm: -1.2, lFore: 0, rFore: 0, lArmX: 0, rArmX: 0, lHandX: 0, rHandX: 0 };
    this._combinedDeltaBuffer = { x: 0, y: 0, angle: 0, scaleX: 0, scaleY: 0, anchorX: 0, anchorY: 0, opacity: 0 };

    // Wasm コア参照
    this.wasmCore = null;

    // DOM要素キャッシュ
    this.dom = {};
  }

  setWasmCore(wasm) {
    this.wasmCore = wasm;
  }

  init() {
    this.canvas = document.getElementById('avatar-canvas');
    if (this.canvas) {
      this.ctx = this.canvas.getContext('2d');
      this.canvas.width = this.CANVAS_W;
      this.canvas.height = this.CANVAS_H;
    }
    this.videoElement = document.getElementById('video-preview');

    // 頻繁に参照されるDOM要素をキャッシュ
    this.dom = {
      chkBreathe: document.getElementById('chk-breathing'),
      chkAutoBlink: document.getElementById('chk-auto-blink'),
      chkLockEye: document.getElementById('chk-lock-eye'),
      chkLockMouth: document.getElementById('chk-lock-mouth'),
      chkMirror: document.getElementById('chk-mirror'),
      sliderSens: document.getElementById('slider-sens'),
      sliderSmooth: document.getElementById('slider-smooth'),
      sliderMicSens: document.getElementById('slider-mic-sens'),
      sliderNoise: document.getElementById('slider-noise'),
      sliderPitch: document.getElementById('slider-pitch'),
      valPitch: document.getElementById('val-pitch'),
      toast: document.getElementById('avatar-toast')
    };

    this.initEventListeners();
  }

  setActive(active) {
    this.isActive = active;
    const studioContainer = document.getElementById('avatar-studio-container');
    if (studioContainer) {
      studioContainer.style.display = active ? 'flex' : 'none';
    }

    if (active) {
      if (!this.isLoopRunning) {
        this.isLoopRunning = true;
        this.renderLoop();
      }
      this.updateLayout();
    } else {
      this.isLoopRunning = false;
      if (this.renderLoopAnimId) {
        cancelAnimationFrame(this.renderLoopAnimId);
        this.renderLoopAnimId = null;
      }
      if (this.isCameraActive) {
        this.toggleCamera();
      }
    }
  }

  initVRMScene() {
    if (this.vrmRenderer || !window.THREE) return;

    this.vrmCanvas.width = this.CANVAS_W;
    this.vrmCanvas.height = this.CANVAS_H;
    this.vrmRenderer = new window.THREE.WebGLRenderer({ canvas: this.vrmCanvas, alpha: true, antialias: true });
    this.vrmRenderer.setSize(this.CANVAS_W, this.CANVAS_H);
    this.vrmRenderer.outputColorSpace = window.THREE.SRGBColorSpace;
    this.vrmRenderer.shadowMap.enabled = true;
    this.vrmRenderer.shadowMap.type = window.THREE.PCFSoftShadowMap;

    this.vrmScene = new window.THREE.Scene();
    this.vrmCamera = new window.THREE.PerspectiveCamera(30, this.CANVAS_W / this.CANVAS_H, 0.1, 20.0);
    this.vrmCamera.position.set(0.0, 1.4, 1.4);

    this.vrmControls = new window.OrbitControls(this.vrmCamera, this.canvas);
    this.vrmControls.enableDamping = true;
    this.vrmControls.dampingFactor = 0.05;
    this.vrmControls.target.set(0.0, 1.35, 0.0);
    this.vrmControls.update();

    this.vrmDirectionalLight = new window.THREE.DirectionalLight(0xffffff, 1.5);
    this.vrmDirectionalLight.castShadow = true;
    this.vrmDirectionalLight.shadow.mapSize.width = 2048;
    this.vrmDirectionalLight.shadow.mapSize.height = 2048;
    this.vrmDirectionalLight.shadow.bias = -0.0005;
    this.vrmScene.add(this.vrmDirectionalLight);

    this.vrmSpotLight1 = new window.THREE.SpotLight(0xffffff, 1.5);
    this.vrmSpotLight1.distance = 10.0;
    this.vrmScene.add(this.vrmSpotLight1);
    this.vrmScene.add(this.vrmSpotLight1.target);

    this.vrmSpotLight2 = new window.THREE.SpotLight(0x0055ff, 1.0);
    this.vrmSpotLight2.distance = 10.0;
    this.vrmScene.add(this.vrmSpotLight2);
    this.vrmScene.add(this.vrmSpotLight2.target);

    this.vrmAmbientLight = new window.THREE.AmbientLight(0xffffff, 0.2);
    this.vrmScene.add(this.vrmAmbientLight);

    this.vrmClock = new window.THREE.Clock();
    this.updateLight();
  }

  async loadVRM(file) {
    this.editor.showLoading("VRMモデルを準備中...");

    while (!window.THREE || !window.GLTFLoader || !window.VRMLoaderPlugin) {
      await new Promise(r => setTimeout(r, 50));
    }

    this.initVRMScene();

    if (this.currentVRMUrl) URL.revokeObjectURL(this.currentVRMUrl);
    this.currentVRMUrl = URL.createObjectURL(file);

    const loader = new window.GLTFLoader();
    loader.register((parser) => new window.VRMLoaderPlugin(parser));

    loader.load(this.currentVRMUrl, (gltf) => {
      if (this.currentVrm) {
        if (this.vrmMixer) {
          this.vrmMixer.stopAllAction();
          this.vrmMixer.uncacheRoot(this.currentVrm.scene);
          this.vrmMixer = null;
        }
        this.currentAction = null;
        this.isAnimationPlaying = false;
        this.activePresetPose = null;
        this.vrmScene.remove(this.currentVrm.scene);
        this.currentVrm = null;
      }

      this.currentVrm = gltf.userData.vrm;
      if (window.VRMUtils?.rotateVRM0) {
        window.VRMUtils.rotateVRM0(this.currentVrm);
      }

      const leftUpperArm = this.currentVrm.humanoid.getNormalizedBoneNode('leftUpperArm');
      const rightUpperArm = this.currentVrm.humanoid.getNormalizedBoneNode('rightUpperArm');
      if (leftUpperArm) leftUpperArm.rotation.z = 1.2;
      if (rightUpperArm) rightUpperArm.rotation.z = -1.2;

      const hips = this.currentVrm.humanoid.getNormalizedBoneNode('hips');
      if (hips) {
        if (!this.currentVrm.userData) this.currentVrm.userData = {};
        this.currentVrm.userData.baseHipsY = hips.position.y;
      }

      this.currentVrm.scene.traverse(obj => {
        if (obj.isMesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });

      this.vrmScene.add(this.currentVrm.scene);
      this.currentVrm.scene.rotation.y = Math.PI;
      this.currentVrm.scene.updateMatrixWorld(true);

      this.cacheVRMBones(this.currentVrm);
      this.buildExpressionUI(this.currentVrm);
      this.setVRMCamera('bustup');

      this.loadedMotionClips = [];
      this.rebuildMotionButtons();
      this.emotionPresets = {};

      this.currentAppMode = 'vrm';
      document.getElementById('header-vrm-angles')?.style.setProperty('display', 'flex');
      document.getElementById('vrm-light-group')?.style.setProperty('display', 'block');
      document.getElementById('vrm-expressions-group')?.style.setProperty('display', 'block');
      document.getElementById('vrm-action-group')?.style.setProperty('display', 'block');

      this.editor.hideLoading();
      this.showToast(`VRM読込完了: ${file.name}`);
    }, undefined, (err) => {
      console.error(err);
      this.editor.hideLoading();
      alert("VRMの読み込みに失敗しました。");
    });
  }

  async loadCharacter2D(data) {
    if (!data || !Array.isArray(data.layers) || data.layers.length === 0) {
      throw new Error("有効なドット絵レイヤーデータが見つかりません。");
    }

    this.layers = [];
    this.original2DWidth = Math.ceil((data.width || 640) / 16) * 16;
    this.original2DHeight = Math.ceil((data.height || 320) / 16) * 16;
    this.CANVAS_W = this.original2DWidth;
    this.CANVAS_H = this.original2DHeight;
    this.canvas.width = this.CANVAS_W;
    this.canvas.height = this.CANVAS_H;

    for (let i = 0; i < data.layers.length; i++) {
      const lData = data.layers[i];
      if (!lData.image) continue;

      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error(`レイヤー [${lData.name || i + 1}] の展開に失敗しました`));
        img.src = lData.image;
      });

      this.layers.push({
        id: lData.id || `layer_${i}`,
        name: lData.name || `レイヤー ${i + 1}`,
        canvas: img,
        visible: lData.visible !== false,
        opacity: lData.opacity !== undefined ? lData.opacity : 1.0,
        blendMode: lData.blendMode || 'source-over',
        parentId: lData.parentId || null,
        anchor: lData.anchor || { x: this.CANVAS_W / 2, y: this.CANVAS_H / 2 },
        zOrder: lData.zOrder !== undefined ? lData.zOrder : 500,
        clipping: lData.clipping || false,
        keyframes: lData.keyframes || {},
        ancestors: []
      });
    }

    this.layers.sort((a, b) => (a.zOrder || 0) - (b.zOrder || 0));
    this.layers.forEach(layer => {
      let current = layer;
      let list = [];
      while (current.parentId) {
        let p = this.layers.find(l => l.id === current.parentId);
        if (p) { list.unshift(p); current = p; } else break;
      }
      layer.ancestors = list;
    });

    if (this.currentVrm) {
      this.vrmScene.remove(this.currentVrm.scene);
      this.currentVrm = null;
    }

    document.getElementById('header-vrm-angles')?.style.setProperty('display', 'none');
    document.getElementById('vrm-light-group')?.style.setProperty('display', 'none');
    document.getElementById('vrm-expressions-group')?.style.setProperty('display', 'none');
    document.getElementById('vrm-action-group')?.style.setProperty('display', 'none');

    this.currentAppMode = '2d';
    this.updateLayout();
    this.showToast("ドット絵キャラクター読込完了");
  }

  async loadVRMAnimation(file) {
    if (!this.currentVrm) { alert("先にキャラクター(VRM)を読み込んでください。"); return; }
    this.editor.showLoading(`${file.name} を解析中...`);

    while (!window.GLTFLoader || !window.VRMAnimationLoaderPlugin || !window.createVRMAnimationClip) {
      await new Promise(r => setTimeout(r, 50));
    }

    const url = URL.createObjectURL(file);
    const loader = new window.GLTFLoader();
    loader.register((parser) => new window.VRMAnimationLoaderPlugin(parser));

    loader.load(url, (gltf) => {
      URL.revokeObjectURL(url);
      const vrmAnimations = gltf.userData.vrmAnimations;
      if (vrmAnimations && vrmAnimations.length > 0) {
        if (!this.vrmMixer) this.vrmMixer = new window.THREE.AnimationMixer(this.currentVrm.scene);
        const clip = window.createVRMAnimationClip(vrmAnimations[0], this.currentVrm);
        const motionName = file.name.replace(/\.vrma$/i, '');
        this.loadedMotionClips.push({ name: motionName, clip: clip });
        this.rebuildMotionButtons();
        this.playLoadedMotion(this.loadedMotionClips.length - 1);
        this.showToast(`モーション登録完了: ${file.name}`);
      }
      this.editor.hideLoading();
    }, undefined, (err) => {
      URL.revokeObjectURL(url);
      console.error(err);
      this.editor.hideLoading();
      alert(`モーション [${file.name}] の読み込みに失敗しました。`);
    });
  }

  rebuildMotionButtons() {
    const container = document.getElementById('vrm-custom-motions');
    if (!container) return;
    container.innerHTML = '';

    if (this.loadedMotionClips.length === 0) {
      container.innerHTML = '<span id="vrm-no-motion-text" style="font-size:10px; color:#888;">※ .vrma を読み込むとここに追加されます</span>';
      return;
    }

    this.loadedMotionClips.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondary';
      btn.style.cssText = 'flex: 1 1 45%; padding: 4px; font-size: 10px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;';
      btn.innerText = item.name;
      btn.onclick = () => this.playLoadedMotion(idx);
      container.appendChild(btn);
    });
  }

  playLoadedMotion(index) {
    if (!this.currentVrm || !this.loadedMotionClips[index]) return;
    this.activePresetPose = null;

    if (!this.vrmMixer) this.vrmMixer = new window.THREE.AnimationMixer(this.currentVrm.scene);
    if (this.currentAction) this.currentAction.stop();

    const clip = this.loadedMotionClips[index].clip;
    this.currentAction = this.vrmMixer.clipAction(clip);
    this.currentAction.reset();
    this.currentAction.play();
    this.isAnimationPlaying = true;
    this.showToast(`再生: ${this.loadedMotionClips[index].name}`);
  }

  stopVRMAnimation() {
    if (this.currentAction) this.currentAction.stop();
    this.isAnimationPlaying = false;
    this.activePresetPose = null;
    this.smoothPose = { lArm: 0, rArm: 0, lFore: 0, rFore: 0, lLeg: 0, rLeg: 0 };

    if (this.currentVrm) {
      const humanoid = this.currentVrm.humanoid;
      const bones = ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftHand', 'rightHand'];
      bones.forEach(name => {
        const bone = humanoid.getNormalizedBoneNode(name);
        if (bone) bone.rotation.set(0, 0, 0);
      });
      const lArm = humanoid.getNormalizedBoneNode('leftUpperArm');
      const rArm = humanoid.getNormalizedBoneNode('rightUpperArm');
      if (lArm) lArm.rotation.set(0, 0, 1.2);
      if (rArm) rArm.rotation.set(0, 0, -1.2);
    }
  }

  playPresetPose(poseName) {
    if (!this.currentVrm) return;
    this.stopVRMAnimation();
    this.activePresetPose = poseName;
    this.showToast(`ポーズ: ${poseName === 'wave' ? '手を振る' : poseName === 'armsFolded' ? '腕組み' : '大の字'}`);
  }

  buildExpressionUI(vrm) {
    const sliderContainer = document.getElementById('vrm-expressions-list');
    const btnContainer = document.getElementById('vrm-emotion-buttons');
    if (!sliderContainer || !btnContainer) return;

    sliderContainer.innerHTML = '';
    btnContainer.innerHTML = '';
    this.manualExpressions = {};
    this.activeVRMEmotion = '';
    this.vrmEmotionShortcuts = { "1": "" };

    const expManager = vrm.expressionManager;
    if (!expManager) return;

    const presetNames = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
    const assignedPresets = new Set();
    const allExps = expManager.expressions;

    const normalBtn = document.createElement('button');
    normalBtn.className = 'btn btn-primary emotion-btn';
    normalBtn.style.cssText = 'width: calc(33% - 4px); padding: 4px; font-size: 10px; background: #28a745;';
    normalBtn.innerText = 'Normal [1]';
    normalBtn.onclick = () => this.setVRMEmotion('');
    btnContainer.appendChild(normalBtn);

    let keyIndex = 2;
    let guideText = "[1] 通常 ";

    allExps.forEach((exp) => {
      const name = exp.expressionName || exp.name;
      if (!name) return;
      const lowerName = name.toLowerCase();
      if (lowerName === 'neutral') return;

      const displayName = name.replace(/^(vrm|vrmexpression|custom|expression|fcl|face|blendshape)[_.]/gi, '');

      const matchedPreset = presetNames.find(p => lowerName.includes(p));
      if (matchedPreset && !assignedPresets.has(matchedPreset) && keyIndex <= 9) {
        assignedPresets.add(matchedPreset);
        const btn = document.createElement('button');
        btn.className = 'btn btn-secondary emotion-btn';
        btn.id = `vrm-emotion-btn-${name}`;
        btn.style.cssText = 'width: calc(33% - 4px); padding: 4px; font-size: 10px; overflow: hidden;';
        btn.innerText = `${displayName} [${keyIndex}]`;
        btn.onclick = () => this.setVRMEmotion(name);
        btnContainer.appendChild(btn);

        this.vrmEmotionShortcuts[keyIndex.toString()] = name;
        guideText += `[${keyIndex}] ${displayName} `;
        keyIndex++;
      }

      this.manualExpressions[name] = 0;
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.style.cssText = 'padding: 2px 0;';

      const label = document.createElement('span');
      label.className = 'row-label';
      label.style.fontSize = '10px';
      label.title = name;
      label.innerText = displayName;

      const valSpan = document.createElement('span');
      valSpan.id = `exp-val-${name}`;
      valSpan.className = 'val-badge';
      valSpan.innerText = '0%';

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.id = `exp-slider-${name}`;
      slider.min = "0";
      slider.max = "100";
      slider.value = "0";
      slider.style.flex = "1";
      slider.oninput = (e) => {
        const rawVal = parseInt(e.target.value);
        const val = rawVal / 100;
        this.manualExpressions[name] = val;
        valSpan.innerText = `${rawVal}%`;

        const slotKey = this.activeVRMEmotion || 'normal';
        if (!this.emotionPresets[slotKey]) this.emotionPresets[slotKey] = {};
        this.emotionPresets[slotKey][name] = val;

        if (this.currentVrm?.expressionManager) {
          this.currentVrm.expressionManager.setValue(name, val);
          if (typeof this.currentVrm.expressionManager.update === 'function') {
            this.currentVrm.expressionManager.update();
          }
        }
      };

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(valSpan);
      sliderContainer.appendChild(row);
    });

    const guideElem = document.getElementById('expression-key-guide');
    if (guideElem) guideElem.innerText = guideText;
  }

  setVRMEmotion(name) {
    this.activeVRMEmotion = name;
    document.querySelectorAll('.emotion-btn').forEach(btn => {
      btn.style.background = '#6c757d';
    });

    if (name === '') {
      const normalBtn = document.querySelector('.emotion-btn');
      if (normalBtn) normalBtn.style.background = '#28a745';
    } else {
      const activeBtn = document.getElementById(`vrm-emotion-btn-${name}`);
      if (activeBtn) activeBtn.style.background = '#007bff';
    }

    const slotKey = name || 'normal';
    const savedPreset = this.emotionPresets[slotKey] || {};

    for (let expName in this.manualExpressions) {
      const val = savedPreset[expName] !== undefined ? savedPreset[expName] : 0;
      this.manualExpressions[expName] = val;
      const slider = document.getElementById(`exp-slider-${expName}`);
      if (slider) slider.value = Math.round(val * 100);
      const valSpan = document.getElementById(`exp-val-${expName}`);
      if (valSpan) valSpan.innerText = `${Math.round(val * 100)}%`;

      if (this.currentVrm?.expressionManager) {
        this.currentVrm.expressionManager.setValue(expName, val);
      }
    }

    if (this.currentVrm?.expressionManager?.update) {
      this.currentVrm.expressionManager.update();
    }
  }

  // MediaPipe AI初期化
  async initFaceLandmarker() {
    this.editor.showLoading("AIトラッキング（顔・体・手）を準備中...");

    while (!window.FilesetResolver || !window.FaceLandmarker) {
      await new Promise(r => setTimeout(r, 50));
    }

    try {
      const filesetResolver = await window.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.3/wasm"
      );

      const [face, pose, hand] = await Promise.all([
        window.FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task", delegate: "GPU" },
          outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true, runningMode: "VIDEO", numFaces: 1
        }),
        window.PoseLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task", delegate: "GPU" },
          runningMode: "VIDEO", numPoses: 1
        }),
        window.HandLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task", delegate: "GPU" },
          runningMode: "VIDEO", numHands: 2
        })
      ]);

      this.faceLandmarker = face;
      this.poseLandmarker = pose;
      this.handLandmarker = hand;
    } catch (e) {
      console.error(e);
      alert("AIモデルの初期化に失敗しました。");
    } finally {
      this.editor.hideLoading();
    }
  }

  async toggleCamera() {
    if (!this.videoElement) this.videoElement = document.getElementById('video-preview');

    const updateCamBtnUI = (active) => {
      const b1 = document.getElementById('btn-camera-toggle');
      const b2 = document.getElementById('header-btn-cam-toggle');
      const text = active ? "カメラ停止" : "カメラ起動";
      if (b1) { b1.innerText = active ? "カメラ停止" : "カメラ起動"; b1.classList.toggle('active', active); }
      if (b2) { b2.innerText = text; b2.classList.toggle('active', active); }
    };

    if (this.isCameraActive) {
      this.isCameraActive = false;
      if (this.videoAnimId) {
        cancelAnimationFrame(this.videoAnimId);
        this.videoAnimId = null;
      }
      updateCamBtnUI(false);
      if (this.videoElement?.srcObject) {
        this.videoElement.srcObject.getTracks().forEach(t => t.stop());
        this.videoElement.srcObject = null;
      }
      if (this.videoElement) this.videoElement.style.display = 'none';
      return;
    }

    await this.initMic();
    if (!this.faceLandmarker) await this.initFaceLandmarker();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.currentFacingMode, width: { ideal: 640 }, height: { ideal: 480 } }
      });
      this.videoElement.srcObject = stream;
      this.isCameraActive = true;
      this.videoElement.style.display = 'block';
      updateCamBtnUI(true);

      this.processVideo();
    } catch (err) {
      alert("カメラの起動に失敗しました: " + err.message);
    }
  }

  async startRecording() {
    this.isRecording = true;
    this.recordedChunks = [];
    this.recStartTime = Date.now();

    const recBtn = document.getElementById('header-btn-avatar-record');
    if (recBtn) recBtn.innerText = "録画停止してエディタへ配置";

    const videoStream = this.canvas.captureStream(30);
    const audioStream = this.processedAudioStream || this.sharedAudioStream;
    const tracks = [...videoStream.getVideoTracks()];
    if (audioStream) tracks.push(...audioStream.getAudioTracks());

    const combinedStream = new MediaStream(tracks);
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    this.mediaRecorder = new MediaRecorder(combinedStream, mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : {});

    this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
    this.mediaRecorder.start(250);
  }

  async stopRecording() {
    return new Promise(resolve => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        this.isRecording = false;
        resolve();
        return;
      }

      this.mediaRecorder.onstop = async () => {
        this.isRecording = false;
        const recBtn = document.getElementById('header-btn-avatar-record');
        if (recBtn) recBtn.innerText = "録画スタート";

        // ★ 録画実時間を正確に計算
        const actualDuration = Math.max(0.5, (Date.now() - (this.recStartTime || Date.now())) / 1000);

        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        const file = new File([blob], `Avatar_${Date.now()}.webm`, { type: 'video/webm' });

        this.editor.showLoading("録画テイクを動画エディタに配置中...");
        const newClip = await this.editor.loadVideoFile(file);

        // ★ 実尺をクリップに確実に反映
        if (newClip) {
          newClip.duration = actualDuration;
          newClip.originalDuration = actualDuration;
          this.editor.recalculateTotalDuration();
          this.editor.setupTimelineUI();
        }

        this.editor.hideLoading();

        if (window.switchAppMode) {
          window.switchAppMode('editor');
        }
        resolve();
      };
      this.mediaRecorder.stop();
    });
  }

  async toggleMicOnly() {
    const btn = document.getElementById('header-btn-mic-only');
    if (this.isMicOnlyActive) {
      this.isMicOnlyActive = false;
      if (btn) { btn.innerText = "マイクのみ"; btn.classList.remove('active'); }
      this.micLevel = 0;
      return;
    }

    try {
      await this.initMic();
      this.isMicOnlyActive = true;
      if (btn) { btn.innerText = "マイク停止"; btn.classList.add('active'); }
    } catch (e) {
      alert("マイクの起動に失敗しました。");
    }
  }

  async switchCamera() {
    if (!this.isCameraActive) return;
    if (this.videoElement?.srcObject) this.videoElement.srcObject.getTracks().forEach(t => t.stop());
    this.currentFacingMode = this.currentFacingMode === "user" ? "environment" : "user";
    this.lastVideoTime = -1;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this.currentFacingMode, width: { ideal: 640 }, height: { ideal: 480 } }
      });
      this.videoElement.srcObject = stream;
      this.videoElement.style.transform = this.currentFacingMode === "user" ? "scaleX(-1)" : "none";
    } catch (e) {
      alert("カメラ切り替えに失敗しました。");
    }
  }

  processVideo() {
    if (!this.isCameraActive) return;

    if (this.videoElement && this.videoElement.readyState >= 2 && this.videoElement.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.videoElement.currentTime;
      const now = performance.now();

      try {
        if (this.faceLandmarker) {
          const faceResults = this.faceLandmarker.detectForVideo(this.videoElement, now);
          if (faceResults.faceBlendshapes?.length > 0 && faceResults.facialTransformationMatrixes?.length > 0) {
            this.mapFaceData(faceResults);
          }
        }

        const isBodyTrackingNeeded = (this.currentCameraMode === 'bustup' || this.currentCameraMode === 'fullbody');
        this.frameSkipCounter++;
        if (this.frameSkipCounter % 2 === 0) {
          if (isBodyTrackingNeeded && this.poseLandmarker && document.getElementById('chk-ai-pose')?.checked) {
            const poseResults = this.poseLandmarker.detectForVideo(this.videoElement, now);
            if (poseResults.landmarks?.length > 0) {
              this.mapPoseData(poseResults.landmarks[0], poseResults.worldLandmarks?.[0]);
            }
          }
        } else {
          if (isBodyTrackingNeeded && this.handLandmarker && document.getElementById('chk-ai-hand')?.checked) {
            const handResults = this.handLandmarker.detectForVideo(this.videoElement, now);
            if (handResults.landmarks?.length > 0) this.mapHandData(handResults);
          }
        }
      } catch (err) {
        console.error("AI検出エラー:", err);
      }
    }
    this.videoAnimId = requestAnimationFrame(() => this.processVideo());
  }

  mapFaceData(results) {
    const shapes = results.faceBlendshapes[0].categories;
    const matrix = results.facialTransformationMatrixes[0].data;

    const sens = (parseFloat(this.dom.sliderSens?.value) || 100) / 100;
    const smooth = (parseFloat(this.dom.sliderSmooth?.value) || 70) / 100;
    const isMirror = !!this.dom.chkMirror?.checked;

    const shapeMap = {};
    for (let i = 0; i < shapes.length; i++) {
      shapeMap[shapes[i].categoryName] = shapes[i].score;
    }

    let rotX = Math.asin(-matrix[6]) * (180 / Math.PI) * sens * 4;
    let rotY = Math.asin(matrix[2]) * (180 / Math.PI) * sens * 4;
    let rotZ = Math.atan2(matrix[1], matrix[0]) * (180 / Math.PI) * sens;

    let eyeL = shapeMap['eyeBlinkLeft'] || 0;
    let eyeR = shapeMap['eyeBlinkRight'] || 0;
    let mouth = shapeMap['jawOpen'] || 0;
    let mouthPucker = shapeMap['mouthPucker'] || 0;
    let mouthSmile = ((shapeMap['mouthSmileLeft'] || 0) + (shapeMap['mouthSmileRight'] || 0)) / 2;

    if (document.getElementById('chk-lock-eye')?.checked) { eyeL = 0; eyeR = 0; }
    if (document.getElementById('chk-lock-mouth')?.checked) { mouth = 0; mouthPucker = 0; mouthSmile = 0; }

    if (isMirror) {
      rotY = -rotY;
      rotZ = -rotZ;
      const tmp = eyeL; eyeL = eyeR; eyeR = tmp;
    }

    const lerp = (cur, target) => cur + (target - cur) * (1 - smooth);
    this.lastRawRot = { x: rotX, y: rotY, z: rotZ };

    const finalX = rotX - this.faceOffset.angleX;
    const finalY = rotY - this.faceOffset.angleY;
    const finalZ = rotZ - this.faceOffset.angleZ;

    this.live2dParams.angleX = lerp(this.live2dParams.angleX, Math.max(-100, Math.min(100, finalX)));
    this.live2dParams.angleY = lerp(this.live2dParams.angleY, Math.max(-100, Math.min(100, -finalY)));
    this.live2dParams.angleZ = lerp(this.live2dParams.angleZ, Math.max(-100, Math.min(100, finalZ)));
    this.live2dParams.eyeL = lerp(this.live2dParams.eyeL, eyeL * -100);
    this.live2dParams.eyeR = lerp(this.live2dParams.eyeR, eyeR * -100);
    this.live2dParams.mouth = lerp(this.live2dParams.mouth, mouth * 100);
    this.live2dParams.aiA = lerp(this.live2dParams.aiA, mouth);
    this.live2dParams.aiI = lerp(this.live2dParams.aiI, mouthSmile);
    this.live2dParams.aiU = lerp(this.live2dParams.aiU, mouthPucker);
  }

  mapHandData(results) {
    this.handState.leftGrip = 0; this.handState.rightGrip = 0;
    const handednessList = results.handedness || results.handednesses;
    if (!handednessList || !results.landmarks) return;

    for (let i = 0; i < handednessList.length; i++) {
      if (!handednessList[i]?.[0]) continue;
      const isRight = handednessList[i][0].categoryName === "Right";
      const lm = results.landmarks[i];
      if (!lm?.[0] || !lm[9] || !lm[12]) continue;

      const distDistal = Math.hypot(lm[12].x - lm[0].x, lm[12].y - lm[0].y);
      const distBase = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y);
      if (distBase === 0) continue;

      const gripRatio = distDistal / distBase;
      let gripVal = 0;
      if (gripRatio < 1.2) gripVal = 1;
      else if (gripRatio < 1.8) gripVal = (1.8 - gripRatio) / 0.6;

      if (isRight) this.handState.leftGrip = gripVal;
      else this.handState.rightGrip = gripVal;
    }
  }

  mapPoseData(landmarks, worldLandmarks) {
    if (!landmarks || landmarks.length < 27) return;
    const wLms = worldLandmarks || landmarks;
    const ls = landmarks[11], le = landmarks[13], lw = landmarks[15];
    const rs = landmarks[12], re = landmarks[14], rw = landmarks[16];
    const lh = landmarks[23], lk = landmarks[25], rh = landmarks[24], rk = landmarks[26];
    if (!ls || !le || !lw || !rs || !re || !rw) return;

    const wLs = wLms[11], wLe = wLms[13], wLw = wLms[15];
    const wRs = wLms[12], wRe = wLms[14], wRw = wLms[16];
    const wLh = wLms[23], wLk = wLms[25], wRh = wLms[24], wRk = wLms[26];

    this.poseData.lVis = ((lw.visibility ?? 1) > 0.5 && (ls.visibility ?? 1) > 0.5 && (le.visibility ?? 1) > 0.5);
    this.poseData.rVis = ((rw.visibility ?? 1) > 0.5 && (rs.visibility ?? 1) > 0.5 && (re.visibility ?? 1) > 0.5);
    this.poseData.legVis = (lh && lk && rh && rk && (lk.visibility ?? 1) > 0.5 && (rk.visibility ?? 1) > 0.5);

    if (this.poseData.lVis) {
      const lArmDx = wLe.x - wLs.x; const lArmDy = wLe.y - wLs.y; const lArmDz = wLe.z - wLs.z;
      this.poseData.lArm = Math.atan2(lArmDy, lArmDx) + Math.PI / 2;
      this.poseData.lArmX = Math.atan2(lArmDz, Math.abs(lArmDy) || 0.001) * -1.8;
      const lForeDx = wLw.x - wLe.x; const lForeDy = wLw.y - wLe.y; const lForeDz = wLw.z - wLe.z;
      this.poseData.lFore = Math.atan2(lForeDy, lForeDx) - Math.atan2(lArmDy, lArmDx);
      this.poseData.lForeX = Math.atan2(lForeDz, Math.abs(lForeDy) || 0.001) * -1.8;
    }
    if (this.poseData.rVis) {
      const rArmDx = wRe.x - wRs.x; const rArmDy = wRe.y - wRs.y; const rArmDz = wRe.z - wRs.z;
      this.poseData.rArm = Math.atan2(rArmDy, rArmDx) - Math.PI / 2;
      this.poseData.rArmX = Math.atan2(rArmDz, Math.abs(rArmDy) || 0.001) * -1.8;
      const rForeDx = wRw.x - wRe.x; const rForeDy = wRw.y - wRe.y; const rForeDz = wRw.z - wRe.z;
      this.poseData.rFore = Math.atan2(rForeDy, rForeDx) - Math.atan2(rArmDy, rArmDx);
      this.poseData.rForeX = Math.atan2(rForeDz, Math.abs(rForeDy) || 0.001) * -1.8;
    }
    if (this.currentCameraMode === 'fullbody' && this.poseData.legVis) {
      this.poseData.lLeg = Math.atan2(wLk.y - wLh.y, wLk.x - wLh.x) - Math.PI / 2;
      this.poseData.rLeg = Math.atan2(wRk.y - wRh.y, wRk.x - wRh.x) - Math.PI / 2;
    }
  }

  async initMic() {
    const audioCtx = this.editor.getAudioContext();
    if (!audioCtx) return;

    if (this.micSource) return;

    try {
      const blob = new Blob([this.pitchShifterCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      try {
        await audioCtx.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      this.sharedAudioStream = stream;

      this.micSource = audioCtx.createMediaStreamSource(stream);
      this.pitchNode = new AudioWorkletNode(audioCtx, 'pitch-shifter', {
        processorOptions: { sampleRate: audioCtx.sampleRate }
      });
      this.monitorGain = audioCtx.createGain();
      this.recordGain = audioCtx.createGain();
      this.recordDestination = audioCtx.createMediaStreamDestination();

      this.analyser = audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      this.updateAudioRouting();
      this.updatePitch();
    } catch (e) {
      console.warn("マイク初期化エラー:", e);
    }
  }

  updateAudioRouting() {
    const audioCtx = this.editor.getAudioContext();
    if (!audioCtx || !this.micSource) return;

    this.micSource.disconnect();
    this.pitchNode.disconnect();
    this.monitorGain.disconnect();
    if (this.recordGain) this.recordGain.disconnect();

    const vcEnabled = !!document.getElementById('chk-vc-enable')?.checked;
    const monitorEnabled = !!document.getElementById('chk-vc-monitor')?.checked;
    const isMuted = !!document.getElementById('chk-mute-out')?.checked;

    let processOutput = vcEnabled ? this.pitchNode : this.micSource;
    if (vcEnabled) this.micSource.connect(this.pitchNode);

    processOutput.connect(this.analyser);

    this.recordGain.gain.value = isMuted ? 0.0 : 1.0;
    processOutput.connect(this.recordGain);
    this.recordGain.connect(this.recordDestination);
    this.processedAudioStream = this.recordDestination.stream;

    this.monitorGain.gain.value = (monitorEnabled && !isMuted) ? 1.0 : 0.0;
    processOutput.connect(this.monitorGain);
    this.monitorGain.connect(audioCtx.destination);
  }

  updatePitch() {
    if (!this.pitchNode) return;
    const semitones = parseInt(this.dom.sliderPitch?.value) || 0;
    const ratio = Math.pow(2, semitones / 12);
    this.pitchNode.port.postMessage({ pitchRatio: ratio });
    if (this.dom.valPitch) this.dom.valPitch.innerText = semitones > 0 ? `+${semitones}` : `${semitones}`;
  }

  updateMicLevel() {
    if (!this.analyser) { this.micLevel = 0; return; }
    this.analyser.getByteFrequencyData(this.dataArray);
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) sum += this.dataArray[i];
    let avg = sum / this.dataArray.length;

    const sens = ((parseFloat(document.getElementById('slider-mic-sens')?.value) || 50) / 100) * 100;
    const noiseGate = parseFloat(document.getElementById('slider-noise')?.value) || 10;

    this.micLevel = avg < noiseGate ? 0 : Math.min(100, (avg / 128) * sens);
  }

  // 2D補間・メッシュ変形・親子連動
  getInterpolatedState(keys, val, targetObj) {
    if (!targetObj) targetObj = {};
    if (keys.length === 1 || val <= keys[0].val) return Object.assign(targetObj, keys[0].state);
    if (val >= keys[keys.length - 1].val) return Object.assign(targetObj, keys[keys.length - 1].state);

    let k0 = keys[0], k1 = keys[1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (val >= keys[i].val && val <= keys[i + 1].val) {
        k0 = keys[i]; k1 = keys[i + 1]; break;
      }
    }
    const range = k1.val - k0.val;
    const t = range === 0 ? 0 : (val - k0.val) / range;
    const s0 = k0.state, s1 = k1.state;
    const props = ['x', 'y', 'angle', 'scaleX', 'scaleY', 'anchorX', 'anchorY'];

    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      targetObj[p] = (s0[p] ?? 0) + ((s1[p] ?? 0) - (s0[p] ?? 0)) * t;
    }
    targetObj.opacity = (s0.opacity ?? 1.0) + ((s1.opacity ?? 1.0) - (s0.opacity ?? 1.0)) * t;
    targetObj.isFree = !!s0.isFree;

    if (s0.isFree && s1.isFree && s0.freePoints && s1.freePoints) {
      if (!targetObj.freePoints) targetObj.freePoints = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
      for (let i = 0; i < 4; i++) {
        targetObj.freePoints[i].x = s0.freePoints[i].x + (s1.freePoints[i].x - s0.freePoints[i].x) * t;
        targetObj.freePoints[i].y = s0.freePoints[i].y + (s1.freePoints[i].y - s0.freePoints[i].y) * t;
      }
    }
    return targetObj;
  }

  getLayerCombinedState(layer, currentParams) {
    if (!layer.keyframes) return null;
    const combinedDelta = this._combinedDeltaBuffer;
    combinedDelta.x = 0; combinedDelta.y = 0; combinedDelta.angle = 0;
    combinedDelta.scaleX = 0; combinedDelta.scaleY = 0;
    combinedDelta.anchorX = 0; combinedDelta.anchorY = 0; combinedDelta.opacity = 0;

    let baseState = null, combinedFree = null;
    let hasAny = false;

    for (let p in currentParams) {
      const keys = layer.keyframes[p];
      if (keys && keys.length > 0) {
        const s0 = this.getInterpolatedState(keys, 0, this._tempS0);
        const sv = this.getInterpolatedState(keys, currentParams[p], this._tempSv);
        if (!baseState) baseState = Object.assign({}, s0);
        hasAny = true;
        combinedDelta.x += (sv.x - s0.x);
        combinedDelta.y += (sv.y - s0.y);
        combinedDelta.angle += (sv.angle - s0.angle);
        combinedDelta.scaleX += (sv.scaleX - s0.scaleX);
        combinedDelta.scaleY += (sv.scaleY - s0.scaleY);
        combinedDelta.anchorX += (sv.anchorX - s0.anchorX);
        combinedDelta.anchorY += (sv.anchorY - s0.anchorY);
        combinedDelta.opacity += ((sv.opacity ?? 1) - (s0.opacity ?? 1));

        if (s0.isFree && sv.isFree && s0.freePoints && sv.freePoints) {
          if (!combinedFree) combinedFree = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
          for (let i = 0; i < 4; i++) {
            combinedFree[i].x += (sv.freePoints[i].x - s0.freePoints[i].x);
            combinedFree[i].y += (sv.freePoints[i].y - s0.freePoints[i].y);
          }
        }
      }
    }
    if (!hasAny) return null;

    let res = Object.assign(this._tempRes, baseState);
    ['x', 'y', 'angle', 'scaleX', 'scaleY', 'anchorX', 'anchorY'].forEach(prop => {
      res[prop] += combinedDelta[prop];
    });
    res.opacity = Math.max(0, Math.min(1, (baseState.opacity ?? 1) + combinedDelta.opacity));
    if (baseState.isFree && combinedFree && baseState.freePoints) {
      if (!res.freePoints) res.freePoints = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
      for (let i = 0; i < 4; i++) {
        res.freePoints[i].x = baseState.freePoints[i].x + combinedFree[i].x;
        res.freePoints[i].y = baseState.freePoints[i].y + combinedFree[i].y;
      }
    }
    return res;
  }

  drawFreeTransform(ctx, img, pts) {
    const subdivs = 10;
    const w = img.width, h = img.height;
    const p0 = pts[0], p1 = pts[1], p2 = pts[3], p3 = pts[2];

    const renderTri = (pA, pB, pC, uA_r, vA_r, uB_r, vB_r, uC_r, vC_r) => {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y); ctx.lineTo(pB.x, pB.y); ctx.lineTo(pC.x, pC.y);
      ctx.closePath();
      ctx.clip();
      const uA = uA_r * w, vA = vA_r * h;
      const uB = uB_r * w, vB = vB_r * h;
      const uC = uC_r * w, vC = vC_r * h;
      const d = uA * (vB - vC) - uB * (vA - vC) + uC * (vA - vB);
      if (Math.abs(d) >= 0.0001) {
        const a = (pA.x * (vB - vC) - pB.x * (vA - vC) + pC.x * (vA - vB)) / d;
        const b = (pA.y * (vB - vC) - pB.y * (vA - vC) + pC.y * (vA - vB)) / d;
        const c = (uA * (pB.x - pC.x) - uB * (pA.x - pC.x) + uC * (pA.x - pB.x)) / d;
        const e = (uA * (pB.y - pC.y) - uB * (pA.y - pC.y) + uC * (pA.y - pB.y)) / d;
        ctx.transform(a, b, c, e, pA.x - a * uA - c * vA, pA.y - b * uA - e * vA);
        ctx.drawImage(img, -0.5, -0.5, w + 1, h + 1);
      }
      ctx.restore();
    };

    for (let i = 0; i < subdivs; i++) {
      const u0 = i / subdivs, u1 = (i + 1) / subdivs;
      for (let j = 0; j < subdivs; j++) {
        const v0 = j / subdivs, v1 = (j + 1) / subdivs;
        const p00 = { x: p0.x * (1 - u0) * (1 - v0) + p1.x * u0 * (1 - v0) + p2.x * (1 - u0) * v0 + p3.x * u0 * v0, y: p0.y * (1 - u0) * (1 - v0) + p1.y * u0 * (1 - v0) + p2.y * (1 - u0) * v0 + p3.y * u0 * v0 };
        const p10 = { x: p0.x * (1 - u1) * (1 - v0) + p1.x * u1 * (1 - v0) + p2.x * (1 - u1) * v0 + p3.x * u1 * v0, y: p0.y * (1 - u1) * (1 - v0) + p1.y * u1 * (1 - v0) + p2.y * (1 - u1) * v0 + p3.y * u1 * v0 };
        const p01 = { x: p0.x * (1 - u0) * (1 - v1) + p1.x * u0 * (1 - v1) + p2.x * (1 - u0) * v1 + p3.x * u0 * v1, y: p0.y * (1 - u0) * (1 - v1) + p1.y * u0 * (1 - v1) + p2.y * (1 - u0) * v1 + p3.y * u0 * v1 };
        const p11 = { x: p0.x * (1 - u1) * (1 - v1) + p1.x * u1 * (1 - v1) + p2.x * (1 - u1) * v1 + p3.x * u1 * v1, y: p0.y * (1 - u1) * (1 - v1) + p1.y * u1 * (1 - v1) + p2.y * (1 - u1) * v1 + p3.y * u1 * v1 };
        renderTri(p00, p10, p01, u0, v0, u1, v0, u0, v1);
        renderTri(p11, p01, p10, u1, v1, u0, v1, u1, v0);
      }
    }
  }

  // アバター描画メインループ
  renderLoop() {
    if (!this.isActive || !this.isLoopRunning) return;

    this.updateMicLevel();

    const spring = 0.1, damp = 0.8;
    this.physicsState.vx += (this.live2dParams.angleX - this.physicsState.x) * spring;
    this.physicsState.vy += (this.live2dParams.angleY - this.physicsState.y) * spring;
    this.physicsState.vx *= damp;
    this.physicsState.vy *= damp;
    this.physicsState.x += this.physicsState.vx;
    this.physicsState.y += this.physicsState.vy;

    const motionOffset = this.getAutoMotionsOffset();
    const finalParams = Object.assign(this._renderFinalParams, this.live2dParams);

    for (let key in finalParams) {
      finalParams[key] += (motionOffset[key] || 0) + (this.expressionOffset[key] || 0);
    }
    finalParams.physicsX = this.physicsState.x - this.live2dParams.angleX;
    finalParams.physicsY = this.physicsState.y - this.live2dParams.angleY;
    finalParams.eyeL = Math.min(finalParams.eyeL, motionOffset.eyeL || 0);
    finalParams.eyeR = Math.min(finalParams.eyeR, motionOffset.eyeR || 0);
    finalParams.mouth = Math.max(finalParams.mouth, motionOffset.mouth || 0);

    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.CANVAS_W, this.CANVAS_H);
      if (this.currentBgColor !== 'transparent') {
        this.ctx.fillStyle = this.currentBgColor;
        this.ctx.fillRect(0, 0, this.CANVAS_W, this.CANVAS_H);
      }
      if (this.bgVideo && this.bgVideo.readyState >= 2) {
        this.drawBackgroundCover(this.ctx, this.bgVideo, this.CANVAS_W, this.CANVAS_H);
      } else if (this.bgImage && this.bgImage.complete) {
        this.drawBackgroundCover(this.ctx, this.bgImage, this.CANVAS_W, this.CANVAS_H);
      }

      if (this.currentAppMode === 'vrm' && this.currentVrm) {
        this.renderVRMFrame(finalParams);
      } else if (this.currentAppMode === '2d') {
        this.render2DFrame(finalParams);
      }

      // ★ 背景が「グリーンバック/ブルーバック等」かつ Wasm が利用可能な場合、リアルタイム透過処理を適用
      if (this.currentBgColor === 'transparent' && this.wasmCore && this.wasmCore.apply_chroma_key) {
        try {
          const imgData = this.ctx.getImageData(0, 0, this.CANVAS_W, this.CANVAS_H);
          const uint8View = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength);
          this.wasmCore.apply_chroma_key(uint8View, 0, 255, 0, 40.0, 10.0);
          this.ctx.putImageData(imgData, 0, 0);
        } catch (e) {}
      }
    }

    this.renderLoopAnimId = requestAnimationFrame(() => this.renderLoop());
  }

  getAutoMotionsOffset() {
    const offset = this._motionOffsetCache;
    offset.angleX = 0; offset.angleY = 0; offset.eyeL = 0; offset.eyeR = 0;
    offset.mouth = this.dom.chkLockMouth?.checked ? 0 : this.micLevel;

    if (this.dom.chkBreathe?.checked) {
      const now = Date.now();
      offset.angleY = Math.sin(now / 600) * 5;
      if (now > this.gazeTimer) {
        this.randomGazeX = (Math.random() - 0.5) * 15;
        this.randomGazeY = (Math.random() - 0.5) * 5;
        this.gazeTimer = now + 2000 + Math.random() * 2000;
      }
      offset.angleX += this.randomGazeX;
      offset.angleY += this.randomGazeY;
    }

    if (this.dom.chkAutoBlink?.checked && !this.dom.chkLockEye?.checked) {
      if (Math.random() > 0.98 && this.blinkValue === 0) this.blinkValue = 1;
      if (this.blinkValue > 0) {
        this.blinkValue += 0.2;
        let b = Math.sin(this.blinkValue * Math.PI);
        offset.eyeL = b * -100;
        offset.eyeR = b * -100;
        if (this.blinkValue >= 1) this.blinkValue = 0;
      }
    }
    return offset;
  }

  renderVRMFrame(params) {
    let deltaTime = Math.min(this.vrmClock.getDelta(), 0.1);
    if (this.vrmControls) this.vrmControls.update();
    if (this.vrmMixer && this.isAnimationPlaying) this.vrmMixer.update(deltaTime);

    const now = Date.now();
    const head = this.vrmBones.head;
    const neck = this.vrmBones.neck;
    const spine = this.vrmBones.spine;
    const chest = this.vrmBones.chest;
    const hips = this.vrmBones.hips;

    const radZ = -params.angleZ * 0.015;
    const radY = -params.angleY * 0.015;
    const radX = params.angleX * 0.015;

    if (this.currentCameraMode === 'face') {
      if (head) head.rotation.set(radX * 0.6, radY * 0.6, radZ * 0.6);
      if (neck) neck.rotation.set(radX * 0.3, radY * 0.3, radZ * 0.3);
    } else {
      if (head) head.rotation.set(radX * 0.5, radY * 0.5, radZ * 0.5);
      if (neck) neck.rotation.set(radX * 0.25, radY * 0.25, radZ * 0.25);
      if (!this.isAnimationPlaying) {
        if (chest) chest.rotation.set(radX * 0.15, radY * 0.15, radZ * 0.15);
        if (spine) spine.rotation.set(radX * 0.15, radY * 0.15, radZ * 0.15);
      }
    }

    if (hips && this.currentVrm.userData?.baseHipsY !== undefined) {
      let targetHipsY = this.currentVrm.userData.baseHipsY;
      if (document.getElementById('chk-breathing')?.checked) {
        targetHipsY += Math.sin(now / 800) * 0.015;
      }
      hips.position.y += (targetHipsY - hips.position.y) * 0.1;
    }

    // 腕・脚ポーズ制御
    if (!this.isAnimationPlaying) {
      const lArm = this.vrmBones.lArm;
      const rArm = this.vrmBones.rArm;
      const lFore = this.vrmBones.lFore;
      const rFore = this.vrmBones.rFore;
      const lHand = this.vrmBones.lHand;
      const rHand = this.vrmBones.rHand;

      const tgt = this._poseTgtBuffer;
      tgt.lArm = 1.2; tgt.rArm = -1.2; tgt.lFore = 0; tgt.rFore = 0;
      tgt.lArmX = 0; tgt.rArmX = 0; tgt.lHandX = 0; tgt.rHandX = 0;

      if (!this.activePresetPose) {
        if (this.poseData.lVis) { tgt.lArm = this.poseData.lArm; tgt.lArmX = this.poseData.lArmX || 0; }
        if (this.poseData.rVis) { tgt.rArm = this.poseData.rArm; tgt.rArmX = this.poseData.rArmX || 0; }
        tgt.lHandX = this.handState.leftGrip * 0.8;
        tgt.rHandX = this.handState.rightGrip * 0.8;
      } else if (this.activePresetPose === 'wave') {
        tgt.rArm = -1.1; tgt.rArmX = 0.3; tgt.rFore = -1.8;
        tgt.lArm = 1.2;
      }

      const lerp = 0.12;
      ['lArm', 'rArm', 'lArmX', 'rArmX', 'lFore', 'rFore', 'lHandX', 'rHandX'].forEach(p => {
        if (this.smoothPose[p] === undefined) this.smoothPose[p] = 0;
        this.smoothPose[p] += ((tgt[p] ?? 0) - this.smoothPose[p]) * lerp;
      });

      if (lArm) lArm.rotation.set(this.smoothPose.lArmX, 0, this.smoothPose.lArm);
      if (rArm) rArm.rotation.set(this.smoothPose.rArmX, 0, this.smoothPose.rArm);
      if (lHand) lHand.rotation.set(this.smoothPose.lHandX, 0, 0);
      if (rHand) rHand.rotation.set(this.smoothPose.rHandX, 0, 0);
    }

    // リップシンク & 表情モーフ
    const exp = this.currentVrm.expressionManager;
    if (exp) {
      ['happy', 'angry', 'sad', 'relaxed', 'surprised'].forEach(e => {
        let val = (this.activeVRMEmotion === e) ? 1.0 : 0;
        exp.setValue(e, val);
      });

      let bL = Math.max(0, params.eyeL / -100);
      let bR = Math.max(0, params.eyeR / -100);
      if (bL > 0 || bR > 0 || !this.isAnimationPlaying) {
        exp.setValue('blinkLeft', bL);
        exp.setValue('blinkRight', bR);
      }

      let vol = Math.min(1.0, this.micLevel / 100);
      this.smoothMouth.aa += (vol - this.smoothMouth.aa) * 0.6;
      exp.setValue('aa', this.smoothMouth.aa);

      for (const name in this.manualExpressions) {
        if (this.manualExpressions[name] > 0) exp.setValue(name, this.manualExpressions[name]);
      }
      if (typeof exp.update === 'function') exp.update();
    }

    this.currentVrm.update(deltaTime);
    this.vrmRenderer.render(this.vrmScene, this.vrmCamera);
    this.ctx.drawImage(this.vrmCanvas, 0, 0, this.CANVAS_W, this.CANVAS_H);
  }

  render2DFrame(finalParams) {
    this.layers.forEach(layer => {
      if (!layer.visible) return;

      // ★ 条件付き表示 (visCond) の判定：条件を満たさない差分パーツはスキップ
      if (layer.visCond && layer.visCond.param !== 'always') {
        const currentVal = finalParams[layer.visCond.param] || 0;
        const targetVal = layer.visCond.val;
        if (layer.visCond.comp === 'gt' && !(currentVal > targetVal)) return;
        if (layer.visCond.comp === 'lt' && !(currentVal < targetVal)) return;
      }

      const mState = this.getLayerCombinedState(layer, finalParams);
      this.ctx.save();
      this.ctx.globalAlpha = mState ? mState.opacity : layer.opacity;
      this.ctx.globalCompositeOperation = layer.clipping ? 'source-atop' : layer.blendMode;

      const ancestors = layer.ancestors || [];
      for (let i = 0; i < ancestors.length; i++) {
        const parent = ancestors[i];
        const ps = this.getLayerCombinedState(parent, finalParams);
        if (ps) {
          this.ctx.translate(ps.anchorX - parent.anchor.x, ps.anchorY - parent.anchor.y);
          this.ctx.translate(parent.anchor.x, parent.anchor.y);
          this.ctx.rotate(ps.angle);
          this.ctx.scale(ps.scaleX, ps.scaleY);
          this.ctx.translate(-parent.anchor.x, -parent.anchor.y);
        }
      }

      if (mState) {
        const s = mState;
        this.ctx.translate(s.anchorX, s.anchorY);
        this.ctx.rotate(s.angle);
        this.ctx.scale(s.scaleX, s.scaleY);
        if (s.isFree && s.freePoints) {
          this.ctx.restore(); this.ctx.save();
          if (layer.clipping) this.ctx.globalCompositeOperation = 'source-atop';
          this.drawFreeTransform(this.ctx, layer.canvas, s.freePoints);
        } else {
          this.ctx.drawImage(layer.canvas, s.x - s.anchorX, s.y - s.anchorY);
        }
      } else {
        this.ctx.drawImage(layer.canvas, 0, 0);
      }
      this.ctx.restore();
    });
  }

  drawBackgroundCover(ctx, media, w, h) {
    const mw = media.videoWidth || media.width;
    const mh = media.videoHeight || media.height;
    if (!mw || !mh) return;
    const scale = Math.max(w / mw, h / mh);
    const dw = mw * scale, dh = mh * scale;
    ctx.drawImage(media, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  updateLight() {
    if (!this.vrmAmbientLight || !this.vrmDirectionalLight) return;
    const lightType = document.getElementById('sel-light-type')?.value || 'directional';
    const ambient = (parseInt(document.getElementById('slider-ambient')?.value) || 20) / 100;
    const valAmb = document.getElementById('val-ambient');
    if (valAmb) valAmb.innerText = Math.round(ambient * 100);
    this.vrmAmbientLight.intensity = ambient;

    const spotSettings = document.getElementById('spot-settings');
    const subLightGrp = document.getElementById('sub-light-group');
    if (spotSettings) spotSettings.style.display = (lightType === 'spot') ? 'block' : 'none';
    if (subLightGrp) subLightGrp.style.display = (lightType === 'spot') ? 'block' : 'none';

    const int1 = parseInt(document.getElementById('slider-light1-int')?.value) || 150;
    const deg1X = parseInt(document.getElementById('slider-light1-x')?.value) || 30;
    const deg1Y = parseInt(document.getElementById('slider-light1-y')?.value) || 20;
    const color1 = document.getElementById('light1-color')?.value || '#ffffff';

    const rad1X = deg1X * (Math.PI / 180);
    const rad1Y = deg1Y * (Math.PI / 180);

    if (lightType === 'directional') {
      this.vrmDirectionalLight.visible = true;
      this.vrmSpotLight1.visible = false;
      this.vrmSpotLight2.visible = false;
      this.vrmDirectionalLight.intensity = (int1 / 100) * 1.5;
      this.vrmDirectionalLight.color.set(color1);
      this.vrmDirectionalLight.position.set(Math.sin(rad1X) * Math.cos(rad1Y), Math.sin(rad1Y), Math.cos(rad1X) * Math.cos(rad1Y)).normalize();
    } else {
      this.vrmDirectionalLight.visible = false;
      this.vrmSpotLight1.visible = true;
      this.vrmSpotLight2.visible = true;
      const sizeDeg = parseInt(document.getElementById('slider-light-size')?.value) || 20;
      const edge = 1.0 - ((parseInt(document.getElementById('slider-light-edge')?.value) || 80) / 100);
      const angleRad = sizeDeg * (Math.PI / 180);
      const dist = 2.5;

      this.vrmSpotLight1.intensity = (int1 / 100) * 3;
      this.vrmSpotLight1.color.set(color1);
      this.vrmSpotLight1.angle = angleRad;
      this.vrmSpotLight1.penumbra = edge;
      this.vrmSpotLight1.position.set(Math.sin(rad1X) * Math.cos(rad1Y) * dist, Math.sin(rad1Y) * dist + 1.2, Math.cos(rad1X) * Math.cos(rad1Y) * dist);
      this.vrmSpotLight1.target.position.set(0, 1.2, 0);
      this.vrmSpotLight1.target.updateMatrixWorld();

      const int2 = parseInt(document.getElementById('slider-light2-int')?.value) || 100;
      const deg2X = parseInt(document.getElementById('slider-light2-x')?.value) || -120;
      const deg2Y = parseInt(document.getElementById('slider-light2-y')?.value) || 0;
      const color2 = document.getElementById('light2-color')?.value || '#0055ff';
      const rad2X = deg2X * (Math.PI / 180);
      const rad2Y = deg2Y * (Math.PI / 180);

      this.vrmSpotLight2.intensity = (int2 / 100) * 3;
      this.vrmSpotLight2.color.set(color2);
      this.vrmSpotLight2.angle = angleRad;
      this.vrmSpotLight2.penumbra = edge;
      this.vrmSpotLight2.position.set(Math.sin(rad2X) * Math.cos(rad2Y) * dist, Math.sin(rad2Y) * dist + 1.2, Math.cos(rad2X) * Math.cos(rad2Y) * dist);
      this.vrmSpotLight2.target.position.set(0, 1.2, 0);
      this.vrmSpotLight2.target.updateMatrixWorld();
    }
  }

  changeBg(val) {
    const picker = document.getElementById('bg-color-picker-avatar');
    const container = document.getElementById('avatar-studio-container');
    this.bgImage = null;
    if (this.bgVideo) { this.bgVideo.pause(); this.bgVideo.src = ""; this.bgVideo = null; }

    if (val === 'custom') {
      if (picker) picker.style.display = 'block';
      this.currentBgColor = picker?.value || '#ff00ff';
      if (container) { container.style.background = this.currentBgColor; }
    } else if (val === 'transparent') {
      if (picker) picker.style.display = 'none';
      this.currentBgColor = 'transparent';
      // 市松模様パターンを適用して透過を可視化
      if (container) {
        container.style.background = 'url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYNgfzcDAwMgAI0AMRiMIMA7QQ2XAwzRQj8uApml00EQzRjPIsIEsDAwAnvM/w0Qh8/EAAAAASUVORK5CYII=") repeat';
      }
      return;
    } else if (val === 'file') {
      if (picker) picker.style.display = 'none';
      document.getElementById('bg-file-input-avatar')?.click();
      this.currentBgColor = 'transparent';
    } else {
      if (picker) picker.style.display = 'none';
      this.currentBgColor = val;
      if (container) { container.style.background = this.currentBgColor; }
    }
  }

  setLayout(x, y) {
    this.currentAlignX = x;
    this.currentAlignY = y;

    // 9点ボタンの選択ハイライト色を更新
    document.querySelectorAll('.btn-layout-grid').forEach(btn => {
      const match = btn.getAttribute('data-align') === `${x}-${y}`;
      btn.className = match ? 'btn btn-primary btn-mini btn-layout-grid' : 'btn btn-secondary btn-mini btn-layout-grid';
    });

    this.updateLayout();
  }

  updateLayout() {
    if (!this.canvas) return;
    const panel = document.getElementById('avatar-ui-panel');
    const openBtn = document.getElementById('avatar-ui-open-btn');
    const userScale = (parseInt(document.getElementById('slider-scale-avatar')?.value) || 100) / 100;
    const isPanelVisible = panel && !panel.classList.contains('hidden');

    if (openBtn) openBtn.style.display = isPanelVisible ? 'none' : 'flex';

    const panelWidth = isPanelVisible ? 310 : 0;
    const availW = Math.max(100, window.innerWidth - panelWidth);
    const availH = Math.max(100, window.innerHeight - 48);

    const baseFitScale = Math.min(availW / this.CANVAS_W, availH / this.CANVAS_H);
    const totalScale = baseFitScale * userScale;

    // キャンバスの位置プロパティを初期化
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = this.canvas.style.bottom = this.canvas.style.left = this.canvas.style.right = 'auto';

    // 1. 上下方向 (Y軸) の配置
    if (this.currentAlignY === 'top') {
      this.canvas.style.top = '10px';
    } else if (this.currentAlignY === 'bottom') {
      this.canvas.style.bottom = '10px';
    } else {
      this.canvas.style.top = '50%';
    }

    // 2. 左右方向 (X軸) の配置
    if (this.currentAlignX === 'left') {
      this.canvas.style.left = '10px';
    } else if (this.currentAlignX === 'right') {
      this.canvas.style.right = `${panelWidth + 10}px`;
    } else {
      this.canvas.style.left = `calc(50% - ${panelWidth / 2}px)`;
    }

    // 3. transformOrigin と translate の整合性を修正
    this.canvas.style.transformOrigin = `${this.currentAlignX} ${this.currentAlignY}`;
    const tx = (this.currentAlignX === 'center') ? '-50%' : '0%';
    const ty = (this.currentAlignY === 'center') ? '-50%' : '0%';
    this.canvas.style.transform = `translate(${tx}, ${ty}) scale(${totalScale})`;

    const guide = document.getElementById('avatar-safe-guide');
    if (guide) {
      guide.style.position = 'absolute';
      guide.style.width = `${this.CANVAS_W}px`;
      guide.style.height = `${this.CANVAS_H}px`;
      guide.style.top = this.canvas.style.top;
      guide.style.bottom = this.canvas.style.bottom;
      guide.style.left = this.canvas.style.left;
      guide.style.right = this.canvas.style.right;
      guide.style.transformOrigin = this.canvas.style.transformOrigin;
      guide.style.transform = this.canvas.style.transform;
    }
  }

  changeResolution(type) {
    if (this.isRecording) { alert("録画中は解像度を変更できません。"); return; }
    this.currentResolutionType = type;
    if (type === 'landscape') { this.CANVAS_W = 1280; this.CANVAS_H = 720; }
    else if (type === 'portrait') { this.CANVAS_W = 720; this.CANVAS_H = 1280; }
    else if (type === 'square') { this.CANVAS_W = 800; this.CANVAS_H = 800; }

    this.canvas.width = this.CANVAS_W;
    this.canvas.height = this.CANVAS_H;

    if (this.currentAppMode === 'vrm' && this.vrmRenderer && this.vrmCamera) {
      this.vrmCanvas.width = this.CANVAS_W;
      this.vrmCanvas.height = this.CANVAS_H;
      this.vrmRenderer.setSize(this.CANVAS_W, this.CANVAS_H);
      this.vrmCamera.aspect = this.CANVAS_W / this.CANVAS_H;
      this.vrmCamera.updateProjectionMatrix();
    }
    this.updateLayout();
  }

  toggleSafeArea() {
    const guide = document.getElementById('avatar-safe-guide');
    const chk = document.getElementById('chk-safe-area-avatar');
    if (guide && chk) guide.style.display = chk.checked ? 'block' : 'none';
  }

  toggleUIVisibility() {
    const panel = document.getElementById('avatar-ui-panel');
    if (panel) panel.classList.toggle('hidden');
    this.updateLayout();
  }

  calibrateFace() {
    this.faceOffset.angleX = this.lastRawRot.x;
    this.faceOffset.angleY = this.lastRawRot.y;
    this.faceOffset.angleZ = this.lastRawRot.z;
    this.showToast("正面位置をリセットしました");
  }

  openOBSWindow() {
    if (this.currentObsWindow && !this.currentObsWindow.closed) {
      this.currentObsWindow.focus();
      return;
    }
    const width = this.CANVAS_W, height = this.CANVAS_H;
    this.currentObsWindow = window.open("", "OBS_Output", `width=${width},height=${height}`);
    if (!this.currentObsWindow) { alert("ポップアップを許可してください。"); return; }

    const doc = this.currentObsWindow.document;
    doc.title = "OBS Output Layer";
    doc.body.style.margin = "0"; doc.body.style.overflow = "hidden";
    doc.body.style.backgroundColor = this.currentBgColor === 'transparent' ? "#000" : this.currentBgColor;

    const outCanvas = doc.createElement("canvas");
    outCanvas.width = width; outCanvas.height = height;
    outCanvas.style.width = "100vw"; outCanvas.style.height = "100vh";
    outCanvas.style.objectFit = "contain"; outCanvas.style.imageRendering = "pixelated";
    doc.body.appendChild(outCanvas);
    const outCtx = outCanvas.getContext("2d");

    const update = () => {
      if (!this.currentObsWindow || this.currentObsWindow.closed) {
        this.currentObsWindow = null;
        return;
      }
      try {
        doc.body.style.backgroundColor = this.currentBgColor === 'transparent' ? "#000" : this.currentBgColor;
        outCtx.clearRect(0, 0, outCanvas.width, outCanvas.height);
        if (this.canvas && this.canvas.width > 0 && this.canvas.height > 0) {
          outCtx.drawImage(this.canvas, 0, 0, outCanvas.width, outCanvas.height);
        }
        this.currentObsWindow.requestAnimationFrame(update);
      } catch (err) {
        this.currentObsWindow = null;
      }
    };
    update();
  }

  async toggleRecording() {
    if (this.isRecording) await this.stopRecording();
    else await this.startRecording();
  }

  showToast(text) {
    const toast = document.getElementById('avatar-toast');
    if (!toast) return;
    toast.innerText = text;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
  }

  cacheVRMBones(vrm) {
    const h = vrm.humanoid;
    this.vrmBones.head = h.getNormalizedBoneNode('head');
    this.vrmBones.neck = h.getNormalizedBoneNode('neck');
    this.vrmBones.spine = h.getNormalizedBoneNode('spine');
    this.vrmBones.chest = h.getNormalizedBoneNode('upperChest') || h.getNormalizedBoneNode('chest');
    this.vrmBones.hips = h.getNormalizedBoneNode('hips');
    this.vrmBones.lArm = h.getNormalizedBoneNode('leftUpperArm');
    this.vrmBones.rArm = h.getNormalizedBoneNode('rightUpperArm');
    this.vrmBones.lFore = h.getNormalizedBoneNode('leftLowerArm');
    this.vrmBones.rFore = h.getNormalizedBoneNode('rightLowerArm');
    this.vrmBones.lHand = h.getNormalizedBoneNode('leftHand');
    this.vrmBones.rHand = h.getNormalizedBoneNode('rightHand');
    this.vrmBones.lLeg = h.getNormalizedBoneNode('leftUpperLeg');
    this.vrmBones.rLeg = h.getNormalizedBoneNode('rightUpperLeg');
  }

  setVRMCamera(mode) {
    if (!this.vrmCamera || !this.vrmControls || !this.currentVrm) return;
    if (!this._vrmCameraWorldPos && window.THREE) this._vrmCameraWorldPos = new window.THREE.Vector3();
    this.currentCameraMode = mode;
    let headY = 1.45;
    const headNode = this.vrmBones.head;
    if (headNode && this._vrmCameraWorldPos) {
      headNode.updateWorldMatrix(true, false);
      headNode.getWorldPosition(this._vrmCameraWorldPos);
      if (this._vrmCameraWorldPos.y > 0.1) headY = this._vrmCameraWorldPos.y;
    }

    if (mode === 'ultra') {
      this.vrmCamera.position.set(0.0, headY, 0.35);
      this.vrmControls.target.set(0.0, headY, 0.0);
    } else if (mode === 'face') {
      this.vrmCamera.position.set(0.0, headY, 0.55);
      this.vrmControls.target.set(0.0, headY, 0.0);
    } else if (mode === 'bustup') {
      this.vrmCamera.position.set(0.0, headY - 0.05, 1.4);
      this.vrmControls.target.set(0.0, headY - 0.1, 0.0);
    } else if (mode === 'fullbody') {
      this.vrmCamera.position.set(0.0, headY * 0.6, 3.3);
      this.vrmControls.target.set(0.0, headY * 0.6, 0.0);
    }
    this.vrmControls.update();
  }

  initEventListeners() {
    window.addEventListener('keydown', (e) => {
      if (!this.isActive || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.toggleUIVisibility();
      }
      const keyStr = e.key;
      if (this.currentAppMode === 'vrm' && this.vrmEmotionShortcuts.hasOwnProperty(keyStr)) {
        this.expressionOffset = { angleX: 0, angleY: 0, angleZ: 0, eyeL: 0, eyeR: 0, mouth: 0, opacity: 0 };
        const emotionName = this.vrmEmotionShortcuts[keyStr];
        this.setVRMEmotion(emotionName);
        this.showToast(`表情: ${emotionName === '' ? '通常 [1]' : emotionName + ' [' + keyStr + ']'}`);
      } else if (this.currentAppMode === '2d') {
        // ★ 2Dドット絵モード用ショートカット
        if (keyStr === '1') { this.expressionOffset = { angleX: 0, angleY: 0, angleZ: 0, eyeL: 0, eyeR: 0, mouth: 0, opacity: 0 }; this.showToast("表情: 通常 [1]"); }
        else if (keyStr === '2') { this.expressionOffset = { angleX: 0, angleY: 0, angleZ: 50, eyeL: 0, eyeR: 0, mouth: 0, opacity: 0 }; this.showToast("表情: 怒り [2]"); }
        else if (keyStr === '3') { this.expressionOffset = { angleX: 0, angleY: 0, angleZ: 0, eyeL: -100, eyeR: -100, mouth: 0, opacity: 0 }; this.showToast("表情: 驚き [3]"); }
        else if (keyStr === '4') { this.expressionOffset = { angleX: 0, angleY: 0, angleZ: 0, eyeL: 0, eyeR: 0, mouth: 50, opacity: 0 }; this.showToast("表情: 笑い [4]"); }
        else if (keyStr === '5') { this.expressionOffset = { angleX: 0, angleY: 0, angleZ: 0, eyeL: 0, eyeR: 0, mouth: 0, opacity: -0.5 }; this.showToast("表情: 照れ [5]"); }
      }
    });

    const dropOverlay = document.getElementById('avatar-drop-overlay');
    let dragCounter = 0;
    window.addEventListener('dragenter', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      dragCounter++;
      if (dropOverlay) dropOverlay.style.display = 'flex';
    });
    window.addEventListener('dragleave', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0 && dropOverlay) dropOverlay.style.display = 'none';
    });
    window.addEventListener('dragover', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
    });
    window.addEventListener('drop', async (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      dragCounter = 0;
      if (dropOverlay) dropOverlay.style.display = 'none';
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        const ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'json') {
          const text = await file.text();
          await this.loadCharacter2D(JSON.parse(text));
        } else if (ext === 'vrm') {
          await this.loadVRM(file);
        } else if (ext === 'vrma') {
          await this.loadVRMAnimation(file);
        }
      }
    });

    // 背景ファイル選択
    document.getElementById('bg-file-input-avatar')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (this.currentBgUrl) URL.revokeObjectURL(this.currentBgUrl);
      this.currentBgUrl = URL.createObjectURL(file);
      if (file.type.startsWith('video/')) {
        this.bgVideo = document.createElement('video');
        this.bgVideo.src = this.currentBgUrl;
        this.bgVideo.loop = true;
        this.bgVideo.muted = true;
        this.bgVideo.playsInline = true;
        this.bgVideo.play().catch(() => {});
      } else {
        this.bgImage = new Image();
        this.bgImage.src = this.currentBgUrl;
      }
    });

    document.getElementById('bg-color-picker-avatar')?.addEventListener('input', (e) => {
      this.currentBgColor = e.target.value;
    });
  }
}

window.AvatarStudioEngine = AvatarStudioEngine;