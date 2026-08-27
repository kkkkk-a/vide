class VideoEditorEngine {
  constructor() {
    this.audioCtx = null;
    this.state = {
      currentTime: 0,
      duration: 10, // ★ 初期状態でも10秒間の作業領域を確保
      isPlaying: false,
      zoom: 60,
      aspectRatio: '9:16',
      bgColor: '#000000',
      isSnapEnabled: true,
      isMultiSelectMode: false, // ★ スマホ向け複数選択モードフラグ
      trackStates: {}, // ★ トラックごとの { [trackIdx]: { locked: false, hidden: false, muted: false } }

      volume: { video: 1.0, bgm: 1.0, pitch: 1.0, isMuted: false }, // pitchを追加

      chromaKey: { enabled: false, targetColor: { r: 0, g: 255, b: 0 }, tolerance: 40, smoothness: 10 },

      // 拡張フィルターの初期値を追加
      filters: {
        brightness: 100, contrast: 100, grayscale: 0,
        sepia: 0, hue: 0, blur: 0, saturate: 100, invert: 0,
        lutPreset: 'none', lutIntensity: 0.8
      },

      markers: [], // ★ 全体タイムラインマーカー [{ time: 2.5, label: "要カット", color: "#ffcc00" }]
      tracks: []
    };
    this.selectedItems = []; // 複数選択中のアイテム配列
    this.screenRecorderState = { mediaRecorder: null, stream: null, chunks: [], timerId: null, startTime: 0 };
    this.clipboard = null;    // コピー・ペースト用バッファ
    this.history = [];
    this.redoStack = [];
    this._mediaRegistry = new Map(); // Undo/Redo復元用メディア要素キャッシュ
    this._clipDomMap = new Map();     // ★ DOM要素参照キャッシュ（querySelector排除）

    this.dragState = {
      isDraggingText: false,
      selectedTextIndex: -1,
      isDraggingClip: false,
      isTrimming: false,
      trimTarget: null,
      selectedClip: null,
      clipStartX: 0,
      clipStartTime: 0,
      clipStartDuration: 0
    };

    this.canvas = document.getElementById('preview-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.timelineTracks = document.getElementById('timeline-tracks');
    this.timelineContainer = document.getElementById('timeline-container');
    this.timeInput = document.getElementById('time-input');
    this.playBtn = document.getElementById('play-btn');

    this.ffmpeg = null;

    // ★ 3Dエンジンの初期化
    this.threeEngine = new ThreeEngine(this.canvas.width, this.canvas.height);
    this.threeScene = this.threeEngine.scene; // 後方互換参照

    // 音声合成エンジンを早期初期化
    this.synthEngine = new AudioSynthEngine(this.getAudioContext(), null);

    // ★ 新要素をいくらでも追加できるプラグイン式描画レジストリ
    this.drawHandlers = {};
    this.initDrawHandlers();

    this.initEvents();
    this.initDragAndDrop();
    this.updateAspectRatio();
    this.updateContextualToolbar();
    this.initWasm(); // ★ Rust Wasm モジュール初期化

    // ★ Webフォント（Google Fonts）の読み込み完了時にテキスト描画キャッシュを完全破棄・再計算
    if (document.fonts) {
      document.fonts.ready.then(() => {
        this.state.tracks.forEach(t => {
          if (t.type === 'text' || t.contentMode === 'text' || t.contentMode === 'cutout') {
            t._cachedLines = null;
            t._lastTextCacheKey = null;
            t._cachedTransform = null;
            t._cachedTransformKey = null;
            t._cachedBitmapKey = null;
            t._cachedCanvas = null;
          }
        });
        this.notifyUpdate({ timeline: true, render: true });
      });
    }

    // ★ 最適化用プロパティ
    this.isNeedsRender = true;
    this.isLoopRunning = false;
    this.lastPlayTimestamp = 0;
    this.playStartVideoTime = 0;

    // ★ 初期状態から再生ボタンと各種コントロールを押せるように解除
    this.enableControls();
    this.notifyUpdate({ duration: true, timeline: true, toolbar: true, render: true });
  }

  // ★ どこからでも1行で状態を自動同期できる柔軟なディスパッチャー（バッチ最適化版）
  notifyUpdate(options = { duration: true, timeline: true, toolbar: true, timeUI: true, render: true }) {
    if (!this._pendingUpdateFlags) {
      this._pendingUpdateFlags = { duration: false, timeline: false, toolbar: false, timeUI: false, render: false };
    }

    if (options.duration) this._pendingUpdateFlags.duration = true;
    if (options.timeline) this._pendingUpdateFlags.timeline = true;
    if (options.toolbar) this._pendingUpdateFlags.toolbar = true;
    if (options.timeUI) this._pendingUpdateFlags.timeUI = true;
    if (options.render !== false) this._pendingUpdateFlags.render = true;

    if (!this._isUpdateScheduled) {
      this._isUpdateScheduled = true;
      queueMicrotask(() => {
        const flags = this._pendingUpdateFlags;
        this._isUpdateScheduled = false;
        this._pendingUpdateFlags = { duration: false, timeline: false, toolbar: false, timeUI: false, render: false };

        if (flags.duration) this.recalculateTotalDuration();
        if (flags.timeline) this.setupTimelineUI();
        if (flags.toolbar) this.updateContextualToolbar();
        if (flags.timeUI) this.updateSelectedClipTimeUI();
        if (flags.render) this.requestRender();
      });
    }
  }

  // ★ 素材の幅・高さを一括取得する共通ヘルパー（パステーブル自動解決版）
  getClipDimensions(clip, includeScale = true) {
    let w = 200, h = 100;
    const isShape = clip.type === 'shape' || (this.shapePathRegistry && clip.type in this.shapePathRegistry);

    if (clip.type === 'text') {
      const lineCount = clip._cachedLines?.length || String(clip.text || '').split('\n').length || 1;
      const baseFontSize = clip.fontSize || 48;
      const lines = clip._cachedLines || String(clip.text || '').split('\n');
      this.ctx.font = `bold ${baseFontSize}px "${clip.fontFamily || 'M PLUS Rounded 1c'}", sans-serif`;
      let maxW = 100;
      for (let i = 0; i < lines.length; i++) {
        const textW = this.ctx.measureText(lines[i] || '').width;
        if (textW > maxW) maxW = textW;
      }
      const padding = (clip.stroke2Width || 14) + (clip.strokeWidth || 6) + (clip.glowBlur || 15) + 20;
      w = maxW + padding * 2;
      h = (baseFontSize * 1.3 * lineCount) + padding * 2;
    } else if (isShape) {
      w = clip.width || clip.size || 250;
      h = clip.height || clip.size || 250;
    } else if (clip.element) {
      const ew = clip.element.videoWidth || clip.element.naturalWidth || 300;
      const eh = clip.element.videoHeight || clip.element.naturalHeight || 200;
      const r = Math.min(this.canvas.width / ew, this.canvas.height / eh);
      w = ew * r;
      h = eh * r;
    } else if (clip.type === '3d') {
      // ★ 描画実寸（baseDim * 0.5）と完全に一致させる
      const baseDim = Math.min(this.canvas.width, this.canvas.height) * 0.5;
      w = baseDim;
      h = baseDim;
    }
    const s = includeScale ? (clip.transform?.scale || 1.0) : 1.0;
    return { w: w * s, h: h * s };
  }

  initDrawHandlers() {
    // 1. 動画 / 画像
    const drawMedia = (ctx, clip, animT) => {
      const el = clip.element;
      // readyState < 1 の完全未ロード時のみスキップし、シーク中(readyState >= 1)はフレームを描画
      if (!el || (clip.type === 'video' && el.readyState < 1) || (clip.type === 'image' && (!el.complete || el.naturalWidth === 0))) return;

      const imgW = clip.type === 'video' ? el.videoWidth : el.naturalWidth;
      const imgH = clip.type === 'video' ? el.videoHeight : el.naturalHeight;
      if (!imgW || !imgH) return;

      const ratio = Math.min(this.canvas.width / imgW, this.canvas.height / imgH);
      const drawW = imgW * ratio;
      const drawH = imgH * ratio;

      const radX = ((animT.rotateX || 0) * Math.PI) / 180;
      const radY = ((animT.rotateY || 0) * Math.PI) / 180;
      const scaleX = (animT.scale || 1.0) * Math.cos(radY);
      const scaleY = (animT.scale || 1.0) * Math.cos(radX);

      ctx.save();
      ctx.globalCompositeOperation = clip.blendMode || 'source-over';
      ctx.translate((this.canvas.width / 2) + (animT.x || 0), (this.canvas.height / 2) - (animT.y || 0));
      if (animT.rotation) ctx.rotate((animT.rotation * Math.PI) / 180);
      ctx.scale(scaleX, scaleY);

      // マスク処理（円形または四角形）
      if (clip.maskType === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, Math.min(drawW, drawH) / 2, 0, Math.PI * 2);
        ctx.clip();
      } else if (clip.maskType === 'rect') {
        ctx.beginPath();
        ctx.rect(-drawW / 2, -drawH / 2, drawW, drawH);
        ctx.clip();
      }

      // クロマキー有効時はオフスクリーンバッファで透過計算
      if (this.state.chromaKey.enabled && this._offscreenCanvas && this._offscreenCtx) {
        if (this._offscreenCanvas.width !== imgW || this._offscreenCanvas.height !== imgH) {
          this._offscreenCanvas.width = imgW;
          this._offscreenCanvas.height = imgH;
        }
        this._offscreenCtx.clearRect(0, 0, imgW, imgH);
        this._offscreenCtx.drawImage(el, 0, 0, imgW, imgH);
        this.applyChromaKey(this._offscreenCtx, imgW, imgH);
        ctx.drawImage(this._offscreenCanvas, 0, 0, imgW, imgH, -drawW / 2, -drawH / 2, drawW, drawH);
      } else {
        ctx.drawImage(el, 0, 0, imgW, imgH, -drawW / 2, -drawH / 2, drawW, drawH);
      }

      this.drawSelectionOutline(ctx, clip, drawW, drawH);
      ctx.restore();
    };

    this.drawHandlers['video'] = drawMedia;
    this.drawHandlers['image'] = drawMedia;

    // 2. テキスト（行分割キャッシュ・3Dパースペクティブ回転対応版）
    this.drawHandlers['text'] = (ctx, clip, animT) => {
      ctx.save();
      const baseFontSize = clip.fontSize || 48;
      const drawX = Math.round((this.canvas.width / 2) + (animT.x || 0));
      const drawY = Math.round((this.canvas.height / 2) - (animT.y || 0));
      ctx.translate(drawX, drawY);

      if (animT.rotation) ctx.rotate((animT.rotation * Math.PI) / 180);

      // ★ 3D回転 (X/Y軸) をパースペクティブスケールとして適用
      const radX = ((animT.rotateX || 0) * Math.PI) / 180;
      const radY = ((animT.rotateY || 0) * Math.PI) / 180;
      const scaleX = (animT.scale || 1.0) * Math.cos(radY);
      const scaleY = (animT.scale || 1.0) * Math.cos(radX);
      ctx.scale(scaleX, scaleY);

      ctx.font = `bold ${baseFontSize}px "${clip.fontFamily || 'M PLUS Rounded 1c'}", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = clip.color || '#ffffff';

      let currentContent = clip.text || '';
      if (Array.isArray(clip.textKeyframes) && clip.textKeyframes.length > 0) {
        const relSec = Math.max(0, this.state.currentTime - clip.startTime);
        const kfs = clip.textKeyframes;
        for (let i = 0; i < kfs.length; i++) {
          if (relSec >= kfs[i].time) currentContent = kfs[i].text;
        }
      }

      // タイプライター進行度（0.0 〜 1.0）に応じた表示文字数の制限（サロゲートペア・絵文字安全対応）
      if (animT.typewriterProgress !== undefined && animT.typewriterProgress < 1.0) {
        const chars = Array.from(currentContent);
        const visibleCount = Math.floor(chars.length * Math.max(0, animT.typewriterProgress));
        currentContent = chars.slice(0, visibleCount).join('');
      }

      // 行分割のメモ化キャッシュ
      if (clip._lastTextCacheKey !== currentContent) {
        clip._lastTextCacheKey = currentContent;
        clip._cachedLines = currentContent.split('\n');
      }
      const lines = clip._cachedLines;

      const lineHeight = baseFontSize * 1.3;
      const startY = -((lines.length - 1) * lineHeight) / 2;

      // ★ 自然なドロップシャドウ（奥行き影）の適用
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 4;

      // 1. ネオン光彩 (グロー)
      if (clip.glowEnabled) {
        ctx.shadowColor = clip.glowColor || '#00f0ff';
        ctx.shadowBlur = clip.glowBlur || 15;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }

      // 2. 第2フチ (外側極太ストローク)
      if (clip.stroke2Enabled && (clip.stroke2Width || 0) > 0) {
        ctx.strokeStyle = clip.stroke2Color || '#ff0000';
        ctx.lineWidth = (clip.strokeWidth || 6) + (clip.stroke2Width || 14);
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        for (let i = 0; i < lines.length; i++) {
          ctx.strokeText(lines[i], 0, startY + (i * lineHeight));
        }
      }

      // 3. 第1フチ (内側ストローク)
      if (clip.strokeEnabled !== false && (clip.strokeWidth || 0) > 0) {
        ctx.strokeStyle = clip.strokeColor || '#000000';
        ctx.lineWidth = clip.strokeWidth || 6;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        for (let i = 0; i < lines.length; i++) {
          ctx.strokeText(lines[i], 0, startY + (i * lineHeight));
        }
      }

      // 光彩をリセットして塗りを適用
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

      const inAnimType = clip.animProps?.inAnim;
      const isCharAnim = inAnimType === 'charPop' || inAnimType === 'charDrop' || inAnimType === 'charBounce';
      const relTime = Math.max(0, this.state.currentTime - clip.startTime);
      const inDur = Math.max(0.001, clip.animProps?.inDuration || 0.8);

      // グラデーションスタイルの準備
      let fillStyle = clip.color || '#ffffff';
      if (clip.gradientEnabled) {
        const textHeight = lines.length * lineHeight;
        const grad = ctx.createLinearGradient(0, startY - baseFontSize / 2, 0, startY + textHeight - baseFontSize / 2);
        grad.addColorStop(0, clip.gradientColor1 || '#ffffff');
        grad.addColorStop(1, clip.gradientColor2 || '#ffcc00');
        fillStyle = grad;
      }

      if (isCharAnim) {
        // ★ 文字単位アニメーションレンダリング
        for (let l = 0; l < lines.length; l++) {
          const line = lines[l];
          const chars = Array.from(line);
          const totalChars = chars.length || 1;
          const lineY = startY + (l * lineHeight);

          // 行全体の幅を計測して中央揃えの開始Xを算出
          const lineWidth = ctx.measureText(line).width;
          let curCharX = -lineWidth / 2;

          for (let c = 0; c < totalChars; c++) {
            const ch = chars[c];
            const chWidth = ctx.measureText(ch).width;
            const charCenterOffset = curCharX + chWidth / 2;

            // 1文字ごとの時間差（Stagger）ディレイ計算
            const charDelay = (c / totalChars) * (inDur * 0.6);
            const charRelTime = Math.max(0, relTime - charDelay);
            const charDur = inDur * 0.4;
            const p = Math.min(1.0, charRelTime / charDur);

            let charScale = 1.0;
            let charOffsetY = 0;
            let charAlpha = 1.0;

            if (relTime < inDur) {
              if (inAnimType === 'charPop') {
                charScale = window.AnimationEngine.easeOutBack(p);
                charAlpha = p;
              } else if (inAnimType === 'charDrop') {
                charOffsetY = -(1.0 - window.AnimationEngine.easeOutBounce(p)) * 80;
                charAlpha = p;
              } else if (inAnimType === 'charBounce') {
                charScale = window.AnimationEngine.easeOutBounce(p);
                charAlpha = p;
              }
            }

            if (charAlpha > 0.01) {
              ctx.save();
              ctx.translate(charCenterOffset, lineY);
              ctx.scale(Math.max(0.001, charScale), Math.max(0.001, charScale));
              ctx.translate(0, charOffsetY);
              ctx.globalAlpha *= charAlpha;

              // 第2フチ（textAlign: center なので原点 0, 0 に描画）
              if (clip.stroke2Enabled && (clip.stroke2Width || 0) > 0) {
                ctx.strokeStyle = clip.stroke2Color || '#ff0000';
                ctx.lineWidth = (clip.strokeWidth || 6) + (clip.stroke2Width || 14);
                ctx.strokeText(ch, 0, 0);
              }
              // 第1フチ
              if (clip.strokeEnabled !== false && (clip.strokeWidth || 0) > 0) {
                ctx.strokeStyle = clip.strokeColor || '#000000';
                ctx.lineWidth = clip.strokeWidth || 6;
                ctx.strokeText(ch, 0, 0);
              }
              // 塗り
              ctx.fillStyle = fillStyle;
              ctx.fillText(ch, 0, 0);

              ctx.restore();
            }

            curCharX += chWidth;
          }
        }
      } else {
        // ★ 高速ビットマップキャッシュレンダリング（通常テキスト）
        const cacheKey = `${currentContent}_${baseFontSize}_${clip.fontFamily}_${clip.color}_${clip.strokeEnabled}_${clip.strokeColor}_${clip.strokeWidth}_${clip.stroke2Enabled}_${clip.stroke2Color}_${clip.stroke2Width}_${clip.gradientEnabled}_${clip.gradientColor1}_${clip.gradientColor2}_${clip.glowEnabled}_${clip.glowColor}_${clip.glowBlur}`;

        if (clip._cachedBitmapKey !== cacheKey || !clip._cachedCanvas) {
          clip._cachedBitmapKey = cacheKey;

          if (!clip._cachedCanvas) {
            clip._cachedCanvas = document.createElement('canvas');
          }

          // 文字列の描画サイズを計測
          let maxLineWidth = 0;
          for (let i = 0; i < lines.length; i++) {
            const w = ctx.measureText(lines[i]).width;
            if (w > maxLineWidth) maxLineWidth = w;
          }

          const padding = (clip.stroke2Width || 14) + (clip.strokeWidth || 6) + (clip.glowBlur || 15) + 30;
          const totalW = Math.ceil(maxLineWidth + padding * 2);
          const totalH = Math.ceil(lines.length * lineHeight + padding * 2);

          clip._cachedCanvas.width = totalW;
          clip._cachedCanvas.height = totalH;
          clip._cachedPaddingX = padding;
          clip._cachedPaddingY = padding + ((lines.length - 1) * lineHeight) / 2;

          const offCtx = clip._cachedCanvas.getContext('2d');
          offCtx.font = `bold ${baseFontSize}px "${clip.fontFamily || 'M PLUS Rounded 1c'}", sans-serif`;
          offCtx.textAlign = 'center';
          offCtx.textBaseline = 'middle';

          const centerX = totalW / 2;
          const startYOff = (totalH / 2) - (((lines.length - 1) * lineHeight) / 2);

          // 1. 光彩 (グロー)
          if (clip.glowEnabled) {
            offCtx.shadowColor = clip.glowColor || '#00f0ff';
            offCtx.shadowBlur = clip.glowBlur || 15;
          }

          // 2. 第2フチ (外側)
          if (clip.stroke2Enabled && (clip.stroke2Width || 0) > 0) {
            offCtx.strokeStyle = clip.stroke2Color || '#ff0000';
            offCtx.lineWidth = (clip.strokeWidth || 6) + (clip.stroke2Width || 14);
            offCtx.lineJoin = 'round';
            for (let i = 0; i < lines.length; i++) {
              offCtx.strokeText(lines[i], centerX, startYOff + (i * lineHeight));
            }
          }

          // 3. 第1フチ (内側)
          if (clip.strokeEnabled !== false && (clip.strokeWidth || 0) > 0) {
            offCtx.strokeStyle = clip.strokeColor || '#000000';
            offCtx.lineWidth = clip.strokeWidth || 6;
            offCtx.lineJoin = 'round';
            for (let i = 0; i < lines.length; i++) {
              offCtx.strokeText(lines[i], centerX, startYOff + (i * lineHeight));
            }
          }

          offCtx.shadowColor = 'transparent';
          offCtx.shadowBlur = 0;

          // 4. 塗り (グラデーションまたは単色)
          if (clip.gradientEnabled) {
            const grad = offCtx.createLinearGradient(0, startYOff - baseFontSize / 2, 0, startYOff + (lines.length * lineHeight) - baseFontSize / 2);
            grad.addColorStop(0, clip.gradientColor1 || '#ffffff');
            grad.addColorStop(1, clip.gradientColor2 || '#ffcc00');
            offCtx.fillStyle = grad;
          } else {
            offCtx.fillStyle = clip.color || '#ffffff';
          }

          for (let i = 0; i < lines.length; i++) {
            offCtx.fillText(lines[i], centerX, startYOff + (i * lineHeight));
          }
        }

        // キャッシュ済みビットマップ画像をCanvasへ瞬時転写 (中央基準で配置)
        ctx.drawImage(
          clip._cachedCanvas,
          -clip._cachedCanvas.width / 2,
          -clip._cachedCanvas.height / 2
        );
      }

      // 他の描画に影響しないよう影をクリア
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // 実際の文字サイズに合わせた正確な選択枠を描画
      const bounds = this.getClipDimensions(clip, false);
      this.drawSelectionOutline(ctx, clip, bounds.w, bounds.h);
      ctx.restore();
    };

    // 3. 3Dオブジェクト（AnimationEngine完全連動の高速転写）
    this.drawHandlers['3d'] = (ctx, clip, animT) => {
      if (!clip.model || !this.threeEngine) return;

      const relTime = Math.max(0, this.state.currentTime - clip.startTime);

      // AnimationEngineが算出した 3D回転 (X/Y/Z軸) をそのまま立体モデルへ適用
      const rotX = ((animT.rotateX || 0) * Math.PI) / 180;
      const rotY = ((animT.rotateY || 0) * Math.PI) / 180;
      const rotZ = ((animT.rotation || 0) * Math.PI) / 180;

      clip.model.position.set(0, 0, 0);
      clip.model.rotation.set(rotX, rotY, rotZ);

      // パーティクル・ボーンアニメーションの進行
      if (clip.model.isPoints && this.threeEngine.updateParticleSystem) {
        this.threeEngine.updateParticleSystem(clip.model, relTime, 1.0);
      }
      if (clip.mixer) {
        clip.mixer.setTime(relTime);
      }

      // 単独モデルのみを有効化してレンダリング
      clip.model.visible = true;
      if (this.threeEngine.shadowFloor) {
        this.threeEngine.shadowFloor.visible = true;
      }

      this.threeEngine.render();
      clip.model.visible = false;

      // 4. 単独撮影した3D画像をキャンバスの指定位置に描画
      ctx.save();
      const baseDim = Math.min(this.canvas.width, this.canvas.height);
      const drawW = baseDim * (animT.scale || 0.5);
      const drawH = baseDim * (animT.scale || 0.5);

      ctx.translate(
        Math.round((this.canvas.width / 2) + (animT.x || 0)),
        Math.round((this.canvas.height / 2) - (animT.y || 0))
      );

      ctx.drawImage(this.threeEngine.getDomElement(), -drawW / 2, -drawH / 2, drawW, drawH);
      this.drawSelectionOutline(ctx, clip, drawW, drawH);
      ctx.restore();
    };

    // 4. 多機能 2D 図形描画ハンドラー（3Dパースペクティブ回転＆シャドウ対応版）
    this.shapePathRegistry = window.VideoProcessor?.constructor?.SHAPE_PATHS || {};
    const drawShape = (ctx, clip, animT) => {
      ctx.save();
      const boxW = clip.width || clip.size || 250;
      const boxH = clip.height || clip.size || 250;
      const halfW = boxW / 2;
      const halfH = boxH / 2;

      const drawX = Math.round((this.canvas.width / 2) + (animT.x || 0));
      const drawY = Math.round((this.canvas.height / 2) - (animT.y || 0));
      ctx.translate(drawX, drawY);

      if (animT.rotation) ctx.rotate((animT.rotation * Math.PI) / 180);

      // ★ 3D回転 (X/Y軸) をパースペクティブスケールとして適用（立体裏返り表現）
      const radX = ((animT.rotateX || 0) * Math.PI) / 180;
      const radY = ((animT.rotateY || 0) * Math.PI) / 180;
      const scaleX = (animT.scale || 1.0) * Math.cos(radY);
      const scaleY = (animT.scale || 1.0) * Math.cos(radX);
      ctx.scale(scaleX, scaleY);

      // ★ ドロップシャドウ（影）の適用
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 4;

      ctx.beginPath();
      const shapePathGenerator = this.shapePathRegistry[clip.type] || this.shapePathRegistry['rect'] || ((c, w, h) => c.rect(-w / 2, -h / 2, w, h));
      shapePathGenerator(ctx, boxW, boxH);

      // 塗りの適用
      if (clip.gradientType === 'linear') {
        const rad = ((clip.gradientAngle || 45) * Math.PI) / 180;
        const cos = Math.cos(rad) * halfW;
        const sin = Math.sin(rad) * halfH;
        const grad = ctx.createLinearGradient(-cos, -sin, cos, sin);
        grad.addColorStop(0, clip.gradientColor1 || '#00f0ff');
        grad.addColorStop(1, clip.gradientColor2 || '#ff007f');
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = clip.color || '#00f0ff';
      }
      ctx.fill();

      // 枠線ボーダーの適用
      if (clip.borderWidth > 0) {
        ctx.strokeStyle = clip.borderColor || '#ffffff';
        ctx.lineWidth = clip.borderWidth;
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      this.drawSelectionOutline(ctx, clip, boxW, boxH);
      ctx.restore();
    };

    // パステーブルの全キーから描画ハンドラーを自動登録
    this.drawHandlers['shape'] = drawShape;
    Object.keys(this.shapePathRegistry).forEach(type => {
      this.drawHandlers[type] = drawShape;
    });

    // 5. 複合グループ素材 (group) 最適化版
    this.drawHandlers['group'] = (ctx, clip, animT) => {
      const children = clip.children;
      if (!Array.isArray(children) || children.length === 0) return;
      const relTime = this.state.currentTime - clip.startTime;

      ctx.save();
      ctx.translate((this.canvas.width / 2) + (animT.x || 0), (this.canvas.height / 2) - (animT.y || 0));
      if (animT.rotation) ctx.rotate((animT.rotation * Math.PI) / 180);
      if (animT.scale !== undefined && animT.scale !== 1.0) ctx.scale(animT.scale, animT.scale);

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const childStart = child.relativeStart || 0;
        const childDur = child.duration || 0;
        if (relTime >= childStart && relTime <= childStart + childDur) {
          const childHandler = this.drawHandlers[child.type];
          if (typeof childHandler === 'function') {
            childHandler(ctx, child, child.transform || {});
          }
        }
      }

      this.drawSelectionOutline(ctx, clip, this.canvas.width * 0.6, this.canvas.height * 0.6);
      ctx.restore();
    };
  }

  // 選択枠 ＆ 四隅リサイズ・回転ハンドル描画ヘルパー
  drawSelectionOutline(ctx, clip, w, h) {
    if (!this.selectedItems || this.selectedItems.length === 0) return;

    const isPrimary = this.selectedItems[0]?.id === clip.id;
    const isSelected = isPrimary || this.selectedItems.some(i => i.id === clip.id);
    if (!isSelected) return;

    const halfW = w / 2;
    const halfH = h / 2;

    // 1. 境界線枠
    ctx.beginPath();
    ctx.strokeStyle = isPrimary ? '#ffcc00' : '#00f0ff';
    ctx.lineWidth = isPrimary ? 2.5 : 1.5;
    ctx.strokeRect(-halfW, -halfH, w, h);

    if (!isPrimary) return;

    // 2. 四隅のリサイズ丸ハンドル
    const handleRadius = 6;
    const corners = [
      [-halfW, -halfH],
      [halfW, -halfH],
      [halfW, halfH],
      [-halfW, halfH]
    ];

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;

    corners.forEach(([cx, cy]) => {
      ctx.beginPath();
      ctx.arc(cx, cy, handleRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    // 3. 上部の回転ハンドル (接続線 ＋ 丸ハンドル)
    const rotDist = 28;
    ctx.beginPath();
    ctx.strokeStyle = '#ffcc00';
    ctx.lineWidth = 1.5;
    ctx.moveTo(0, -halfH);
    ctx.lineTo(0, -halfH - rotDist);
    ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = '#ffcc00';
    ctx.strokeStyle = '#000000';
    ctx.arc(0, -halfH - rotDist, handleRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  async initWasm() {
    try {
      // pkg ディレクトリから Wasm を動的インポート
      const wasm = await import('./pkg/video_editor_core.js');
      await wasm.default();
      this.wasmCore = wasm;
      if (this.synthEngine) {
        this.synthEngine.setWasmCore(wasm);
      }
    } catch (e) {
      console.warn("Wasmの読み込みをスキップ (JSフォールバックで動作):", e);
    }
  }
  get selectedItem() {
    return this.selectedItems && this.selectedItems.length > 0 ? this.selectedItems[0] : null;
  }
  getAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      if (AudioCtxClass) {
        this.audioCtx = new AudioCtxClass();
        // ★ デバイス変更・切断時の自動復帰リスナー
        this.audioCtx.onstatechange = () => {
          if (this.audioCtx && this.audioCtx.state === 'suspended' && this.state.isPlaying) {
            this.audioCtx.resume().catch(() => {});
          }
        };
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  // DOM・Canvas・Audioノードを完全除外する安全なシリアライズ
  serializeTrackData(tracks) {
    return tracks.map(t => {
      const {
        element, model, mixer, waveform,
        _audioSourceNode, _audioNodes, _mediaGainNode, _mediaElementSourceNode,
        innerMediaElement, _cachedLines, _cachedTransform, _animResultBuffer,
        _kfResultBuffer, _finalTransformBuffer, _cachedBitmapKey, _cachedCanvas,
        _lastTextCacheKey,
        ...serializable
      } = t;

      return JSON.parse(JSON.stringify(serializable));
    });
  }

  saveState() {
    const rawSnapshot = {
      tracks: this.serializeTrackData(this.state.tracks),
      trackStates: JSON.parse(JSON.stringify(this.state.trackStates || {})),
      duration: this.state.duration,
      currentTime: this.state.currentTime,
      bgColor: this.state.bgColor,
      bgMedia: this.state.bgMedia ? { type: this.state.bgMedia.type, src: this.state.bgMedia.element?.src } : null,
      markers: Array.isArray(this.state.markers) ? JSON.parse(JSON.stringify(this.state.markers)) : [],
      filters: { ...this.state.filters }
    };

    const snapshot = JSON.parse(JSON.stringify(rawSnapshot));
    this.history.push(snapshot);

    // 履歴上限（30件）を超えた古い状態をメモリから完全解放
    if (this.history.length > 30) {
      const discarded = this.history.shift();
      if (discarded && discarded.tracks) {
        // 現在のトラック・Redoスタックのいずれにも存在しないメディアを完全破棄
        const activeIds = new Set(this.state.tracks.map(cur => cur.id));
        this.redoStack.forEach(st => st.tracks?.forEach(t => activeIds.add(t.id)));

        discarded.tracks.forEach(t => {
          if (!activeIds.has(t.id) && this._mediaRegistry) {
            const cached = this._mediaRegistry.get(t.id);
            if (cached && cached.element && cached.element.src && cached.element.src.startsWith('blob:')) {
              URL.revokeObjectURL(cached.element.src);
            }
            this._mediaRegistry.delete(t.id);
          }
        });
      }
    }

    // Redoスタックが破棄される際も不要なBlob参照を解放
    if (this.redoStack.length > 0) {
      const activeIds = new Set(this.state.tracks.map(cur => cur.id));
      this.history.forEach(st => st.tracks?.forEach(t => activeIds.add(t.id)));

      this.redoStack.forEach(st => {
        st.tracks?.forEach(t => {
          if (!activeIds.has(t.id) && this._mediaRegistry) {
            const cached = this._mediaRegistry.get(t.id);
            if (cached && cached.element && cached.element.src && cached.element.src.startsWith('blob:')) {
              URL.revokeObjectURL(cached.element.src);
            }
            this._mediaRegistry.delete(t.id);
          }
        });
      });
      this.redoStack = [];
    }

    this.updateUndoRedoButtons();
  }

  undo() {
    if (this.history.length === 0) return;
    const rawSnapshot = {
      tracks: this.serializeTrackData(this.state.tracks),
      trackStates: JSON.parse(JSON.stringify(this.state.trackStates || {})),
      duration: this.state.duration,
      currentTime: this.state.currentTime,
      bgColor: this.state.bgColor,
      bgMedia: this.state.bgMedia ? { type: this.state.bgMedia.type, src: this.state.bgMedia.element?.src } : null,
      markers: this.state.markers ? (typeof structuredClone === 'function' ? structuredClone(this.state.markers) : JSON.parse(JSON.stringify(this.state.markers))) : [],
      filters: { ...this.state.filters }
    };

    const currentSnapshot = typeof structuredClone === 'function' ? structuredClone(rawSnapshot) : JSON.parse(JSON.stringify(rawSnapshot));
    this.redoStack.push(currentSnapshot);

    const previousState = this.history.pop();
    this.restoreState(previousState);
    this.updateUndoRedoButtons();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const rawSnapshot = {
      tracks: this.serializeTrackData(this.state.tracks),
      trackStates: JSON.parse(JSON.stringify(this.state.trackStates || {})),
      duration: this.state.duration,
      currentTime: this.state.currentTime,
      bgColor: this.state.bgColor,
      bgMedia: this.state.bgMedia ? { type: this.state.bgMedia.type, src: this.state.bgMedia.element?.src } : null,
      markers: this.state.markers ? (typeof structuredClone === 'function' ? structuredClone(this.state.markers) : JSON.parse(JSON.stringify(this.state.markers))) : [],
      filters: { ...this.state.filters }
    };

    const currentSnapshot = typeof structuredClone === 'function' ? structuredClone(rawSnapshot) : JSON.parse(JSON.stringify(rawSnapshot));
    this.history.push(currentSnapshot);

    const nextState = this.redoStack.pop();
    this.restoreState(nextState);
    this.updateUndoRedoButtons();
  }

  restoreState(parsedState) {
    const elementMap = new Map();
    const restoredIds = new Set(parsedState.tracks.map(t => t.id));

    // 現在のトラックを走査し、復元先で不要になる要素をDOM・シーンから除去
    this.state.tracks.forEach(item => {
      if (item && item.id) {
        if (!restoredIds.has(item.id)) {
          this.disposeClip(item);
        } else {
          if (item.element) elementMap.set(item.id, item.element);
          if (item.model) elementMap.set(item.id + '_model', item.model);
          if (item.waveform) elementMap.set(item.id + '_wf', item.waveform);
          if (item.mixer) elementMap.set(item.id + '_mixer', item.mixer);
        }
      }
    });

    // 復元対象から外れた古いタイムラインDOMを完全クリア
    if (this._clipDomMap) {
      for (const [id, domEl] of this._clipDomMap.entries()) {
        if (!restoredIds.has(id)) {
          if (domEl.parentNode) domEl.parentNode.removeChild(domEl);
          this._clipDomMap.delete(id);
        }
      }
    }

    this.state.tracks = parsedState.tracks.map(t => {
      const cached = this._mediaRegistry ? this._mediaRegistry.get(t.id) : null;
      const restoredElement = elementMap.get(t.id) || (cached ? cached.element : null) || t.element || null;
      const restoredModel = elementMap.get(t.id + '_model') || (cached ? cached.model : null) || t.model || null;
      const restoredWf = elementMap.get(t.id + '_wf') || (cached ? cached.waveform : null) || t.waveform || null;
      const restoredMixer = elementMap.get(t.id + '_mixer') || (cached ? cached.mixer : null) || t.mixer || null;
      // ★ 図形内の動画メディアもキャッシュから確実に復元
      const restoredInnerMedia = elementMap.get(t.id + '_inner') || (cached ? cached.innerMediaElement : null) || t.innerMediaElement || null;

      // DOM（非表示video）が外れていれば再接続（Undo復元保証）
      if (restoredElement && t.type === 'video') {
        t._isDisposed = false;
        restoredElement.style.display = 'none';
        if (!restoredElement.parentNode) {
          document.body.appendChild(restoredElement);
        }
        restoredElement.pause(); // 復元時は一旦停止
      } else if (restoredElement && t.type === 'audio') {
        t._isDisposed = false;
      }

      // 3Dモデルの健全性チェックとシーンへの再追加（破棄済みなら再生成）
      let safeModel = restoredModel;
      if (t.type === '3d') {
        const isModelValid = safeModel && safeModel.geometry && safeModel.material;
        if (!isModelValid && this.threeEngine) {
          const shapeType = t.name ? t.name.replace(/^3D\s*/, '').toLowerCase() : 'cube';
          if (shapeType.startsWith('particles')) {
            const pType = shapeType.replace(/^particles?-?/, '');
            safeModel = this.threeEngine.createParticleSystem(pType, 250);
          } else {
            safeModel = this.threeEngine.createPrimitive(shapeType, t.materialProps?.color || '#00f0ff');
          }
          if (t.materialProps) {
            this.threeEngine.applyMaterialProps(safeModel, t.materialProps);
          }
        }
        if (safeModel && this.threeScene && !this.threeScene.children.includes(safeModel)) {
          this.threeScene.add(safeModel);
        }
      }

      // 音声分離状態に応じた消音フラグの再適用
      if (restoredElement && t.type === 'video') {
        restoredElement.muted = !!t.isAudioSeparated || this.state.volume.isMuted;
      }

      return {
        ...t,
        element: restoredElement,
        model: restoredModel,
        waveform: restoredWf,
        mixer: restoredMixer,
        innerMediaElement: restoredInnerMedia // ★ 追加
      };
    });

    // 古い配列の初期化（残骸によるエラー防止）
    this.state.audioTracks = [];
    this.state.textTracks = [];
    this.state.shapeTracks = [];

    this.state.duration = parsedState.duration;
    this.state.bgColor = parsedState.bgColor;
    this.state.trackStates = parsedState.trackStates ? JSON.parse(JSON.stringify(parsedState.trackStates)) : {};
    if (parsedState.bgMedia && parsedState.bgMedia.src) {
      if (parsedState.bgMedia.type === 'image') {
        const img = new Image();
        img.src = parsedState.bgMedia.src;
        this.state.bgMedia = { type: 'image', element: img };
      } else if (parsedState.bgMedia.type === 'video') {
        const vid = document.createElement('video');
        vid.muted = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.src = parsedState.bgMedia.src;
        this.state.bgMedia = { type: 'video', element: vid };
      }
    } else {
      this.state.bgMedia = null;
    }
    this.state.markers = parsedState.markers ? JSON.parse(JSON.stringify(parsedState.markers)) : [];
    if (parsedState.filters) {
      this.state.filters = { ...parsedState.filters };
      // フィルターUIの同期
      const lutSelect = document.getElementById('filter-lut-preset');
      const lutSlider = document.getElementById('filter-lut-intensity');
      const valLut = document.getElementById('val-filter-lut');
      if (lutSelect) lutSelect.value = this.state.filters.lutPreset || 'none';
      if (lutSlider) lutSlider.value = Math.round((this.state.filters.lutIntensity || 0.8) * 100);
      if (valLut) valLut.innerText = `${Math.round((this.state.filters.lutIntensity || 0.8) * 100)}%`;
    }
    this.selectedItems = [];

    // ★ 背景色ピッカーの値をUndo状態に同期
    const bgPicker = document.getElementById('bg-color-picker');
    if (bgPicker) bgPicker.value = this.state.bgColor || '#000000';

    // ★ Undo/Redo 時に時間も当時の位置に復元（虚空に残らないよう総尺でクランプ）
    const targetTime = parsedState.currentTime !== undefined 
      ? Math.max(0, Math.min(parsedState.currentTime, this.state.duration))
      : Math.max(0, Math.min(this.state.currentTime, this.state.duration));

    this.updateSelectedClipTimeUI();
    this.updateContextualToolbar();
    this.setupTimelineUI();
    this.seekTo(targetTime, true); // ★ 動画・音声・3Dモデルの描画を Undo 後の時間へ完全同期
    this.requestRender();
  }
  updateUndoRedoButtons() {
    document.getElementById('btn-undo').disabled = this.history.length === 0;
    document.getElementById('btn-redo').disabled = this.redoStack.length === 0;
  }
  deselectAll() {
    // 既に未選択状態かつパネルが閉じている場合は無駄なDOM更新と再描画をスキップ
    const hadSelection = this.selectedItems && this.selectedItems.length > 0;
    const hasOpenPanel = document.querySelector('.sub-panel:not(.hidden)') !== null;

    if (!hadSelection && !hasOpenPanel) return;

    // 選択アイテムを空にする
    this.selectedItems = [];

    // フッターメニューを初期状態に戻す
    this.updateContextualToolbar();

    // タイムラインの発光枠線を消す
    this.setupTimelineUI();

    // 開いている設定パネルをすべて閉じる
    document.querySelectorAll('.sub-panel').forEach(p => p.classList.add('hidden'));

    // 選択枠（青枠・黄枠）を消すために再描画
    if (hadSelection) {
      this.requestRender();
    }
  }
  updateContextualToolbar() {
    const toolbar = document.getElementById('context-toolbar');
    toolbar.innerHTML = '';

    if (this.selectedItems.length !== 2) {
      document.getElementById('panel-transition')?.classList.add('hidden');
    }

    const appendButtons = (btnList) => {
      btnList.forEach(({ id, label, action, condition = true }) => {
        if (!condition) return;
        const btn = document.createElement('button');
        btn.className = 'tool-btn';
        btn.id = id;
        btn.innerText = label;
        btn.addEventListener('click', action);
        toolbar.appendChild(btn);
      });
    };

    const count = this.selectedItems.length;

    if (count === 0) {
      // 1. 未選択時メニュー
      const hasAudio = this.state.tracks.some(t => t.type === 'video' || t.type === 'audio');
      appendButtons([
        { id: 'tool-text', label: '文字を追加', action: () => {
          this.saveState();
          const startT = this.state.currentTime;
          const newText = {
            id: 'text-' + Date.now(), type: 'text', text: '新しいテキスト', color: '#ffffff',
            fontFamily: 'M PLUS Rounded 1c', fontSize: 48, startTime: startT, duration: 3,
            strokeEnabled: true, strokeColor: '#000000', strokeWidth: 5,
            physics: { enabled: false, bounciness: 0.4, isStatic: false },
            trackIndex: this.getAvailableTrackIndex(startT, 3),
            transform: { scale: 1.0, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 }
          };
          this.state.tracks.push(newText);
          this.selectedItems = [newText];
          this.enableControls();
          this.notifyUpdate();
        }},
        { id: 'tool-script', label: '台本編集', action: () => this.openScriptEditor() },
        { id: 'tool-audio-gen', label: '音・BGM生成', action: () => this.openSongMakerEditor(null) },
        { id: 'tool-stock', label: 'ストック素材', action: () => this.toggleSubPanel('panel-stock-library') },
        { id: 'tool-shape', label: '図形', action: () => this.toggleSubPanel('panel-shape') },
        { id: 'tool-3d', label: '3Dオブジェクト', action: () => this.syncAndToggle3DPanel() },
        { id: 'tool-bgcolor', label: '背景色', action: () => this.toggleSubPanel('panel-bgcolor') },
        { id: 'tool-audio-mix', label: '全体音量', action: () => this.toggleSubPanel('panel-audio') },
        { id: 'tool-paste', label: '貼り付け', action: () => this.pasteItem() },
        { id: 'tool-auto-sub', label: '自動字幕', action: () => this.generateAutoSubtitles(), condition: hasAudio },
        { id: 'tool-filter', label: 'フィルター', action: () => this.toggleSubPanel('panel-filter') }
      ]);
    } else if (count === 1) {
      // 2. 単一素材メニュー
      const item = this.selectedItems[0];
      const type = item.type;
      const hideLabel = item.hidden ? '表示' : '非表示';

      // 共通ボタングループ
      const transformBtn = { id: 'tool-transform', label: '変形', action: () => this.syncAndToggleTransformPanel() };
      const alignBtn = { id: 'tool-align', label: '整列', action: () => this.toggleSubPanel('panel-align') };
      const animBtn = { id: 'tool-anim', label: 'アニメーション', action: () => this.syncAndToggleAnimPanel() };
      const splitBtn = { id: 'tool-split', label: '分割', action: () => this.splitSelectedItem() };
      const hideBtn = { id: 'tool-hide', label: hideLabel, action: () => this.toggleSelectedItemVisibility() };
      const copyBtn = { id: 'tool-copy', label: 'コピー', action: () => this.copySelectedItem() };
      const deleteBtn = { id: 'tool-delete', label: '削除', action: () => this.deleteSelectedItem() };

      // カテゴリ別共通メニュースキーム
      const shapeMenu = [{ id: 'tool-shape-edit', label: '図形設定', action: () => this.syncAndToggleShapePanel() }, transformBtn, alignBtn, animBtn, splitBtn, hideBtn, copyBtn, deleteBtn];

      const typeSpecificMap = {
        audio: [
          { id: 'tool-beat-detect', label: 'AIビート検出', action: () => this.detectAndApplyBeats() },
          { id: 'tool-sm-edit', label: '楽曲編集', action: () => this.openSongMakerEditor(item), condition: !!item.songMakerData },
          splitBtn,
          { id: 'tool-audio-mix', label: '音量・ピッチ', action: () => this.toggleSubPanel('panel-audio') },
          { id: 'tool-auto-sub', label: '自動字幕', action: () => this.generateAutoSubtitles() },
          hideBtn, copyBtn, deleteBtn
        ],
        text: [
          { id: 'tool-text-edit', label: 'テキスト編集', action: () => this.toggleSubPanel('panel-caption-editor') },
          transformBtn, alignBtn, animBtn, splitBtn, hideBtn, copyBtn, deleteBtn
        ],
        '3d': [{ id: 'tool-3d', label: '3D設定', action: () => this.syncAndToggle3DPanel() }, transformBtn, alignBtn, animBtn, splitBtn, hideBtn, copyBtn, deleteBtn],
        image: [splitBtn, transformBtn, alignBtn, animBtn, { id: 'tool-filter', label: 'フィルター', action: () => this.toggleSubPanel('panel-filter') }, { id: 'tool-chroma', label: 'クロマキー', action: () => this.toggleSubPanel('panel-chroma') }, hideBtn, copyBtn, deleteBtn],
        background: [{ id: 'tool-bgcolor', label: '背景設定', action: () => this.toggleSubPanel('panel-bgcolor') }, { id: 'tool-filter', label: 'フィルター', action: () => this.toggleSubPanel('panel-filter') }, hideBtn, deleteBtn],
        group: [transformBtn, alignBtn, animBtn, splitBtn, hideBtn, copyBtn, deleteBtn]
      };

      // 図形タイプ（shapePathRegistry の全キー）に共通図形メニューを自動マッピング
      if (this.shapePathRegistry && (item.type in this.shapePathRegistry || item.type === 'shape')) {
        typeSpecificMap[item.type] = shapeMenu;
      }

      // デフォルト（動画クリップ）
      const defaultVideoMenu = [
        splitBtn,
        { id: 'tool-beat-detect', label: 'AIビート検出', action: () => this.detectAndApplyBeats() },
        { id: 'tool-separate-audio', label: '音声分離', action: () => this.separateAudioFromVideo(), condition: !item.isAudioSeparated },
        { id: 'tool-speed', label: '速度・カット', action: () => this.syncAndToggleSpeedPanel() },
        { id: 'tool-mask', label: 'マスク・合成', action: () => this.syncAndToggleMaskPanel() },
        transformBtn, alignBtn, animBtn,
        { id: 'tool-filter', label: 'フィルター', action: () => this.toggleSubPanel('panel-filter') },
        { id: 'tool-chroma', label: 'クロマキー', action: () => this.toggleSubPanel('panel-chroma') },
        { id: 'tool-audio-mix', label: '音量', action: () => this.toggleSubPanel('panel-audio') },
        { id: 'tool-auto-sub', label: '自動字幕', action: () => this.generateAutoSubtitles() },
        hideBtn, copyBtn, deleteBtn
      ];

      appendButtons(typeSpecificMap[type] || defaultVideoMenu);
    } else {
      // 3. 複数選択時メニュー
      appendButtons([
        { id: 'tool-copy', label: '一括コピー', action: () => this.copySelectedItem() },
        { id: 'tool-align', label: '整列・配置', action: () => this.toggleSubPanel('panel-align') },
        { id: 'tool-transition', label: 'トランジション', action: () => this.toggleSubPanel('panel-transition'), condition: count === 2 },
        { id: 'tool-merge', label: '結合', action: () => this.mergeSelectedItems() },
        { id: 'tool-delete', label: '一括削除', action: () => this.deleteSelectedItem() }
      ]);
    }

    // 整列パネル内の基準(主軸)素材名のリアルタイム更新
    const keyInfoEl = document.getElementById('align-key-target-info');
    if (keyInfoEl) {
      if (this.selectedItems && this.selectedItems.length > 0) {
        const keyItem = this.selectedItems[0];
        const keyName = keyItem.name || keyItem.text || keyItem.type || '素材';
        keyInfoEl.innerText = `基準(主軸): [ ${keyName} ]`;
      } else {
        keyInfoEl.innerText = `基準(主軸): [ 未選択 ]`;
      }
    }

    this.updateSelectedClipTimeUI();
  }
  updateSelectedClipTimeUI() {
    const editorEl = document.getElementById('clip-time-editor');
    if (!editorEl) return;

    const item = this.selectedItem;
    const isHidden = !item;
    if (editorEl.classList.contains('hidden') !== isHidden) {
      editorEl.classList.toggle('hidden', isHidden);
    }
    if (!item) return;

    const s = item.startTime || 0;
    const d = item.duration || 0;
    const nameStr = item.name || item.text || item.type || '素材';
    const cacheKey = `${item.id}_${s.toFixed(1)}_${(s + d).toFixed(1)}_${d.toFixed(1)}_${nameStr}_${!!item.hidden}_${!!item.locked}`;
    if (this._lastClipTimeUIKey === cacheKey) return;
    this._lastClipTimeUIKey = cacheKey;

    const setVal = (id, val, isSpan = false) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (isSpan) {
        if (el.innerText !== val) el.innerText = val;
      } else {
        if (el.value !== val && document.activeElement !== el) el.value = val;
      }
    };

    setVal('clip-type-label', (item.type || '素材').toUpperCase(), true);
    setVal('clip-in-time', s.toFixed(1));
    setVal('clip-out-time', (s + d).toFixed(1));
    setVal('clip-dur-time', d.toFixed(1));

    const quickText = document.getElementById('clip-quick-text');
    if (quickText) {
      const currentVal = item.text !== undefined ? item.text : (item.name || '');
      quickText.placeholder = item.type === 'text' ? '字幕テキスト' : '素材名';
      if (document.activeElement !== quickText && quickText.value !== currentVal) {
        quickText.value = currentVal;
      }
    }

    const btnHide = document.getElementById('btn-clip-toggle-hide');
    if (btnHide) {
      btnHide.innerText = item.hidden ? '非表示' : '表示';
      btnHide.classList.toggle('active', !!item.hidden);
    }

    const btnLock = document.getElementById('btn-clip-toggle-lock');
    if (btnLock) {
      btnLock.innerText = item.locked ? 'ロック中' : 'ロック';
      btnLock.classList.toggle('active', !!item.locked);
    }

    const btnMute = document.getElementById('btn-clip-toggle-mute');
    if (btnMute) {
      const hasAudio = item.type === 'video' || item.type === 'audio';
      btnMute.style.display = hasAudio ? 'inline-block' : 'none';
      const isMuted = item.customVolume === 0 || !!item.isAudioMuted;
      btnMute.innerText = isMuted ? '消音中' : '消音';
      btnMute.classList.toggle('active', isMuted);
    }
  }
  toggleSubPanel(panelId) {
    // 試聴プレビュー & Song Maker の再生を安全に停止
    if (this.synthEngine) {
      this.synthEngine.stopPreview();
    }
    const smPlayBtn = document.getElementById('btn-sm-play');
    if (smPlayBtn && smPlayBtn.innerText.includes('停止')) {
      smPlayBtn.click(); // Song Maker のループ演奏を停止
    }

    const panels = document.querySelectorAll('.sub-panel');
    let isOpened = false;

    panels.forEach(p => {
      if (p.id === panelId) {
        const isHidden = p.classList.contains('hidden');
        if (isHidden) {
          p.classList.remove('hidden');
          isOpened = true;
          if (panelId === 'panel-caption-editor') {
            setTimeout(() => this.initQuillEditor(), 50);
          }
        } else {
          p.classList.add('hidden');
        }
      } else {
        p.classList.add('hidden');
      }
    });

    // フッターボタンのハイライト（activeクラス）の付け外し
    document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));

    if (isOpened) {
      // パネルIDとフッターボタンIDの紐付け判定
      const panelToBtnMap = {
        'panel-audio-gen': 'tool-audio-gen',
        'panel-script-editor': 'tool-script',
        'panel-caption-editor': this.selectedItems.length > 0 ? 'tool-text-edit' : 'tool-text',
        // ★ 図形選択時は tool-shape-edit、未選択時は tool-shape を正しく青く光らせる
        'panel-shape': this.selectedItems.length > 0 ? 'tool-shape-edit' : 'tool-shape',
        'panel-3d': 'tool-3d',
        'panel-bgcolor': 'tool-bgcolor',
        'panel-audio': 'tool-audio-mix',
        'panel-filter': 'tool-filter',
        'panel-transform': 'tool-transform',
        'panel-align': 'tool-align', // ★ 整列パネルのアクティブ点灯紐付け
        'panel-chroma': 'tool-chroma',
        'panel-anim': 'tool-anim',
        'panel-transition': 'tool-transition'
      };

      const activeBtnId = panelToBtnMap[panelId];
      if (activeBtnId) {
        const activeBtn = document.getElementById(activeBtnId);
        if (activeBtn) activeBtn.classList.add('active');
      }
    }
  }
  // 宣言的プロパティバインディング定義
  static TRANSFORM_SCHEMA = [
    { id: 'trans-scale', key: 'scale', unit: '%', toUI: v => Math.round((v ?? 1) * 100) },
    { id: 'trans-rotate', key: 'rotation', unit: '度', toUI: v => v || 0 },
    { id: 'trans-rotate-x', key: 'rotateX', unit: '度', toUI: v => v || 0 },
    { id: 'trans-rotate-y', key: 'rotateY', unit: '度', toUI: v => v || 0 },
    { id: 'trans-x', key: 'x', unit: 'px', toUI: v => v || 0 },
    { id: 'trans-y', key: 'y', unit: 'px', toUI: v => v || 0 }
  ];

  // 宣言的フィルタースキーマ定義（キー、初期値、CSS関数名、単位）
  static FILTER_SCHEMA = [
    { key: 'brightness', default: 100, cssFn: 'brightness', unit: '%' },
    { key: 'contrast', default: 100, cssFn: 'contrast', unit: '%' },
    { key: 'grayscale', default: 0, cssFn: 'grayscale', unit: '%' },
    { key: 'sepia', default: 0, cssFn: 'sepia', unit: '%' },
    { key: 'hue', default: 0, cssFn: 'hue-rotate', unit: 'deg' },
    { key: 'blur', default: 0, cssFn: 'blur', unit: 'px' },
    { key: 'saturate', default: 100, cssFn: 'saturate', unit: '%' },
    { key: 'invert', default: 0, cssFn: 'invert', unit: '%' }
  ];

  syncAndToggleTransformPanel() {
    if (!this.selectedItem?.transform) return;
    const t = this.selectedItem.transform;

    // スキーマに基づきUIスライダーとバッジを自動一括同期
    VideoEditorEngine.TRANSFORM_SCHEMA.forEach(({ id, key, unit, toUI }) => {
      const val = toUI(t[key]);
      const el = document.getElementById(id);
      const bEl = document.getElementById(`val-${id}`);
      if (el) el.value = val;
      if (bEl) bEl.innerText = `${val}${unit}`;
    });

    // 物理プロパティの同期（1つのセレクトボックスへ統合）
    const p = this.selectedItem.physics || { enabled: false, bounciness: 0.4, isStatic: false };
    const modeSelect = document.getElementById('phys-mode-select');
    const rowBounce = document.getElementById('row-phys-bounce');
    const sliderBounce = document.getElementById('phys-bounce-rate');
    const valBounce = document.getElementById('val-phys-bounce');

    let currentMode = 'none';
    if (p.enabled) {
      if (p.isStatic) currentMode = 'static';
      else if (p.isAnimated) currentMode = 'animated'; // ★ アニメーション連動判定
      else currentMode = 'dynamic';
    }

    if (modeSelect) modeSelect.value = currentMode;
    if (rowBounce) rowBounce.classList.toggle('hidden', currentMode === 'none');
    if (sliderBounce) sliderBounce.value = Math.round((p.bounciness || 0.4) * 100);
    if (valBounce) valBounce.innerText = `${Math.round((p.bounciness || 0.4) * 100)}%`;

    this.toggleSubPanel('panel-transform');
  }
  syncAndToggle3DPanel() {
    const item = this.selectedItem;
    const isEditing = item && item.type === '3d';
    const titleEl = document.getElementById('label-3d-panel-title');
    const addBtn = document.getElementById('add-3d-btn');

    // ★ 選択中か新規追加かでタイトルとボタンを自動切り替え
    if (isEditing) {
      if (titleEl) titleEl.innerText = '3Dマテリアル & エフェクト設定 (上書き更新)';
      if (addBtn) addBtn.classList.add('hidden'); // 編集時はリアルタイム更新のためボタン非表示
    } else {
      if (titleEl) titleEl.innerText = '3Dオブジェクトを追加';
      if (addBtn) addBtn.classList.remove('hidden'); // 新規作成時は「タイムラインに追加」ボタンを表示
    }

    const clip = isEditing ? item : {
      name: '3D 平面板',
      animMode: 'spin',
      animSpeed: 1.0,
      materialProps: {
        color: '#00f0ff',
        metalness: 0.4,
        roughness: 0.3,
        wireframe: false,
        shaderType: 'standard',
        opacity: 1.0,
        emissiveIntensity: 0.2,
        particleSize: 0.08,
        gradientEnabled: false
      }
    };

    const mProps = clip.materialProps || {};

    // 形状セレクトボックスの同期
    const shapeSelect = document.getElementById('3d-shape-type');
    if (shapeSelect && clip.name) {
      const rawName = clip.name.replace(/^3D\s*/, '').toLowerCase();
      const matchedOpt = Array.from(shapeSelect.options).find(o => rawName.includes(o.value) || o.text.includes(rawName));
      if (matchedOpt) shapeSelect.value = matchedOpt.value;
    }

    document.getElementById('3d-shader-type').value = mProps.shaderType || 'standard';
    document.getElementById('3d-color').value = mProps.color || '#00f0ff';
    document.getElementById('3d-wireframe').checked = !!mProps.wireframe;

    // 3Dスライダーとバッジ数値のデータ駆動一括代入（質感・マテリアルに特化）
    const sliderSyncMap = [
      { id: '3d-opacity', badge: 'val-3d-opacity', val: Math.round((mProps.opacity ?? 1.0) * 100), unit: '%' },
      { id: '3d-emissive', badge: 'val-3d-emissive', val: Math.round((mProps.emissiveIntensity || 0.2) * 100), unit: '%' },
      { id: '3d-metalness', badge: 'val-3d-metalness', val: Math.round((mProps.metalness || 0.4) * 100), unit: '%' },
      { id: '3d-roughness', badge: 'val-3d-roughness', val: Math.round((mProps.roughness || 0.3) * 100), unit: '%' },
      { id: '3d-particle-size', badge: 'val-3d-particle-size', val: Math.round((mProps.particleSize || 0.08) * 100), unit: 'px' }
    ];

    sliderSyncMap.forEach(({ id, badge, val, unit, display }) => {
      const el = document.getElementById(id);
      const badgeEl = document.getElementById(badge);
      if (el) el.value = val;
      if (badgeEl) badgeEl.innerText = `${display !== undefined ? display : val}${unit}`;
    });

    const gradChk = document.getElementById('3d-gradient-enabled');
    const gradGrp = document.getElementById('3d-gradient-group');
    if (gradChk) gradChk.checked = !!mProps.gradientEnabled;
    if (gradGrp) gradGrp.classList.toggle('hidden', !mProps.gradientEnabled);
    if (document.getElementById('3d-grad-color1')) document.getElementById('3d-grad-color1').value = mProps.gradientColor1 || '#00f0ff';
    if (document.getElementById('3d-grad-color2')) document.getElementById('3d-grad-color2').value = mProps.gradientColor2 || '#7928ca';

    // ★ パーティクル選択時は不要な立体パラメータ（金属感・粗さ・ワイヤーフレーム）を自動で非表示化
    const currentShapeVal = document.getElementById('3d-shape-type')?.value || '';
    const isParticle = currentShapeVal.startsWith('particles-') || (clip.model && clip.model.isPoints);

    const metalRow = document.getElementById('3d-metalness')?.closest('span');
    const roughRow = document.getElementById('3d-roughness')?.closest('span');
    const wireRow = document.getElementById('3d-wireframe')?.closest('span');
    const partRow = document.getElementById('3d-particle-size')?.closest('span');

    if (metalRow) metalRow.style.display = isParticle ? 'none' : 'flex';
    if (roughRow) roughRow.style.display = isParticle ? 'none' : 'flex';
    if (wireRow) wireRow.style.display = isParticle ? 'none' : 'flex';
    if (partRow) partRow.style.display = isParticle ? 'flex' : 'none';

    this.toggleSubPanel('panel-3d');
  }
  syncAndToggleAnimPanel() {
    if (!this.selectedItem) return;
    const clip = this.selectedItem;
    const anim = clip.animProps || { inAnim: 'none', mainAnim: 'none', outAnim: 'none' };

    const inEl = document.getElementById('anim-in-type');
    const mainEl = document.getElementById('anim-main-type');
    const outEl = document.getElementById('anim-out-type');
    const presets = window.AnimationEngine.presets;

    // presetsデータからoption要素を動的生成するヘルパー関数
    const populateOptions = (selectEl, optionsArray, selectedValue) => {
      if (!selectEl || !optionsArray) return;
      selectEl.innerHTML = optionsArray.map(opt =>
        `<option value="${opt.id}" ${opt.id === selectedValue ? 'selected' : ''}>${opt.label}</option>`
      ).join('');
    };

    if (inEl && presets.in) populateOptions(inEl, presets.in, anim.inAnim || 'none');
    if (mainEl && presets.main) populateOptions(mainEl, presets.main, anim.mainAnim || 'none');
    if (outEl && presets.out) populateOptions(outEl, presets.out, anim.outAnim || 'none');

    this.renderMainAnimList();
    this.renderClipKeyframeList();
    this.toggleSubPanel('panel-anim');
  }

  // 速度・無音カットパネルの同期
  syncAndToggleSpeedPanel() {
    if (!this.selectedItem) return;
    const speedSelect = document.getElementById('clip-speed-select');
    if (speedSelect) {
      speedSelect.value = String(this.selectedItem.playbackSpeed || 1.0);
    }
    this.toggleSubPanel('panel-speed-process');
  }

  // マスク・合成パネルの同期
  syncAndToggleMaskPanel() {
    if (!this.selectedItem) return;
    const maskSelect = document.getElementById('clip-mask-type');
    const blendSelect = document.getElementById('clip-blend-mode');
    if (maskSelect) maskSelect.value = this.selectedItem.maskType || 'none';
    if (blendSelect) blendSelect.value = this.selectedItem.blendMode || 'source-over';
    this.toggleSubPanel('panel-mask-blend');
  }

  // 自由キーフレーム一覧の描画（速度カーブ選択UI対応版）
  renderClipKeyframeList() {
    const listEl = document.getElementById('clip-keyframe-list');
    if (!listEl || !this.selectedItem) return;
    listEl.innerHTML = '';

    const kfs = this.selectedItem.keyframes || [];
    if (kfs.length === 0) {
      listEl.innerHTML = '<span style="font-size:10px; color:var(--text-sub);">キーフレームはありません</span>';
      return;
    }

    const relTime = Math.max(0, this.state.currentTime - this.selectedItem.startTime);
    const presets = window.KeyframeEngine?.constructor?.EASING_PRESETS || [];

    kfs.forEach((kf, idx) => {
      const row = document.createElement('div');
      row.className = `keyframe-item-row ${Math.abs(relTime - kf.time) < 0.05 ? 'active' : ''}`;

      const optionsHtml = presets.map(p => 
        `<option value="${p.id}" ${kf.easing === p.id ? 'selected' : ''}>${p.label}</option>`
      ).join('');

      row.innerHTML = `
        <span class="keyframe-time-badge">${kf.time.toFixed(2)}s</span>
        <span style="font-size:10px;">X:${Math.round(kf.props.x || 0)} Y:${Math.round(kf.props.y || 0)} ${Math.round((kf.props.scale || 1) * 100)}%</span>
        ${idx > 0 ? `<select class="dropdown dropdown-kf-ease" style="padding:1px 4px; font-size:9px;">${optionsHtml}</select>` : '<span style="font-size:9px; color:var(--text-sub);">開始点</span>'}
        <button class="btn btn-secondary btn-del-mini">DEL</button>
      `;

      row.onclick = () => {
        this.seekTo(this.selectedItem.startTime + kf.time, true);
        this.renderClipKeyframeList();
      };

      const easeSelect = row.querySelector('.dropdown-kf-ease');
      if (easeSelect) {
        easeSelect.onpointerdown = (e) => e.stopPropagation();
        easeSelect.onchange = (e) => {
          this.saveState();
          kf.easing = e.target.value;
          this.requestRender();
        };
      }

      const delBtn = row.querySelector('.btn-del-mini');
      if (delBtn) {
        delBtn.onclick = (e) => {
          e.stopPropagation();
          this.saveState();
          window.KeyframeEngine.removeKeyframe(this.selectedItem, kf.id);
          this.renderClipKeyframeList();
          this.notifyUpdate({ duration: false, toolbar: false });
        };
      }

      listEl.appendChild(row);
    });
  }

  // ストック素材（SVGベクター素材）の追加処理
  addStockSticker() {
    this.saveState();
    const select = document.getElementById('stock-sticker-select');
    const colorInput = document.getElementById('stock-sticker-color');
    const stickerId = select ? select.value : 'svg-like';
    const color = colorInput ? colorInput.value : '#00f0ff';

    const { clip, imageElement } = window.StockLibrary.createStickerClip(
      stickerId,
      color,
      this.state.currentTime,
      5
    );

    imageElement.onload = () => this.requestRender();
    this.addTrackClip(clip);

    this.toggleSubPanel('panel-stock-library');
    if (document.activeElement?.blur) document.activeElement.blur();
  }

  // 無音部分自動カット（ジャンプカット）の実行
  async executeSilenceCut() {
    const clip = this.selectedItem;
    if (!clip || (clip.type !== 'video' && clip.type !== 'audio') || !clip.element) {
      alert("無音カットを行う動画または音声素材を選択してください。");
      return;
    }

    const threshold = parseFloat(document.getElementById('silence-threshold-select')?.value) || 0.025;

    this.showLoading("音声を解析して無音部分を自動検出中...");

    try {
      const audioCtx = this.getAudioContext();
      const segments = await window.VideoProcessor.extractSpeechSegmentsFromElement(clip.element, audioCtx, threshold);

      if (!segments || segments.length === 0) {
        alert("有効な発話区間が検出されませんでした。");
        return;
      }

      this.saveState();

      const originalStartTime = clip.startTime || 0;
      const baseOffset = clip.mediaOffset || 0;
      const trackIdx = clip.trackIndex || 0;

      // 元のクリップを除去
      this.state.tracks = this.state.tracks.filter(t => t.id !== clip.id);

      // 発話区間ごとに詰めてタイムラインへ再配置
      let currentTimelineStart = originalStartTime;
      const newClips = [];

      segments.forEach((seg, index) => {
        const segDuration = Math.max(0.2, seg.end - seg.start);

        let newEl = null;
        if (clip.type === 'video') {
          newEl = document.createElement('video');
          newEl.playsInline = true;
          newEl.style.display = 'none';
          newEl.src = clip.element.src;
          newEl.preload = 'auto';
          document.body.appendChild(newEl);
        } else {
          newEl = new Audio(clip.element.src);
        }

        const newSegClip = {
          ...JSON.parse(JSON.stringify(clip)),
          id: `clip-cut-${Date.now()}-${index}`,
          startTime: currentTimelineStart,
          duration: segDuration,
          mediaOffset: baseOffset + seg.start,
          originalDuration: segDuration,
          trackIndex: trackIdx,
          element: newEl
        };

        this.state.tracks.push(newSegClip);
        newClips.push(newSegClip);

        currentTimelineStart += segDuration;
      });

      this.selectedItems = newClips;
      this.recalculateTotalDuration();
      this.setupTimelineUI();
      this.updateContextualToolbar();
      this.seekTo(originalStartTime, true);
      this.requestRender();

      alert(`無音カットが完了しました。\n(無音区間を削除し、${segments.length} 個の発話区間に最適化しました)`);
    } catch (err) {
      alert("無音カット処理に失敗しました: " + err.message);
    } finally {
      this.hideLoading();
    }
  }

  addMainAnimation(type = 'float', delay = 0, duration = 0, loop = true) {
    if (!this.selectedItem) return;
    this.saveState();

    if (!this.selectedItem.mainAnimations) {
      this.selectedItem.mainAnimations = [];
    }

    this.selectedItem.mainAnimations.push({
      id: 'anim-' + Date.now(),
      type: type,
      delay: delay,
      duration: duration,
      loop: loop,
      speed: 3,
      intensity: 15
    });
    this.renderMainAnimList(); // リスト表示更新
  }

  removeMainAnimation(animId) {
    if (!this.selectedItem || !this.selectedItem.mainAnimations) return;
    this.saveState();
    this.selectedItem.mainAnimations = this.selectedItem.mainAnimations.filter(a => a.id !== animId);
    this.renderMainAnimList(); // リスト表示更新
  }

  // 登録済み途中アニメーションの描画
  renderMainAnimList() {
    const listEl = document.getElementById('main-anim-list');
    if (!listEl || !this.selectedItem) return;
    listEl.innerHTML = '';

    const anims = this.selectedItem.mainAnimations || [];
    if (anims.length === 0) {
      listEl.innerHTML = '<span style="font-size:10px; color:var(--text-sub);">途中効果はありません</span>';
      return;
    }

    anims.forEach((anim, idx) => {
      const row = document.createElement('div');
      row.className = 'anim-item-row';
      row.innerHTML = `<span>${idx + 1}. ${anim.type} (${anim.delay}s後 / ${anim.duration === 0 ? '最後まで' : anim.duration + 's'})</span><button class="btn btn-secondary btn-del-mini">✕</button>`;
      row.querySelector('button').onclick = () => { this.removeMainAnimation(anim.id); this.requestRender(); };
      listEl.appendChild(row);
    });
  }
  updateClipAnimation() {
    if (!this.selectedItem) return;
    this.saveState();

    const inEl = document.getElementById('anim-in-type');
    const mainEl = document.getElementById('anim-main-type');
    const outEl = document.getElementById('anim-out-type');

    this.selectedItem.animProps = {
      ...(this.selectedItem.animProps || {}),
      inAnim: inEl ? inEl.value : 'none',
      mainAnim: mainEl ? mainEl.value : 'none',
      outAnim: outEl ? outEl.value : 'none',
      inDuration: this.selectedItem.animProps?.inDuration || 0.8,
      outDuration: this.selectedItem.animProps?.outDuration || 0.8
    };
    this.requestRender();
  }
calculateAnimTransform(clip) {
    // 1. 通常のアニメーション計算結果を取得
    const animTransform = window.AnimationEngine.calculateTransform(clip, this.state.currentTime);

    // クリップ固有の合成出力バッファを初期化
    if (!clip._finalTransformBuffer) {
      clip._finalTransformBuffer = { scale: 1, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0, opacity: 1, typewriterProgress: 1.0 };
    }
    const finalTransform = clip._finalTransformBuffer;
    Object.assign(finalTransform, animTransform);

    // 2. 自由キーフレームがある場合は合成用バッファに上書き（AnimationEngine側のキャッシュを汚染しない）
    if (window.KeyframeEngine && clip.keyframes && clip.keyframes.length > 0) {
      const kf = window.KeyframeEngine.evaluate(clip, this.state.currentTime);
      finalTransform.x = kf.x;
      finalTransform.y = kf.y;
      finalTransform.scale = kf.scale;
      finalTransform.rotation = kf.rotation;
      finalTransform.rotateX = kf.rotateX;
      finalTransform.rotateY = kf.rotateY;
      finalTransform.opacity = kf.opacity;
    }

    return finalTransform;
  }
  initQuillEditor() {
    if (!window.Quill || !document.getElementById('quill-editor')) return;

    const item = this.selectedItem;

    // 現在時間に対応するキーフレームを取得するヘルパー
    const getActiveKeyframe = (clip) => {
      if (!clip || !clip.textKeyframes || clip.textKeyframes.length === 0) return null;
      const relSec = Math.max(0, this.state.currentTime - clip.startTime);
      let activeKf = clip.textKeyframes[0];
      for (let k = 0; k < clip.textKeyframes.length; k++) {
        if (relSec >= clip.textKeyframes[k].time) {
          activeKf = clip.textKeyframes[k];
        }
      }
      return activeKf;
    };

    if (!this.quill) {
      const Font = Quill.import('formats/font');
      Font.whitelist = ['m-plus-rounded', 'dot-gothic', 'klee-one', 'shippori-mincho', 'sans-serif'];
      Quill.register(Font, true);

      this.quill = new Quill('#quill-editor', {
        theme: 'snow',
        modules: {
          toolbar: [
            [{ 'font': Font.whitelist }],
            [{ 'color': [] }],
            ['bold', 'italic']
          ]
        },
        placeholder: 'ここにテキストを入力...'
      });

      // テキスト入力時のリアルタイム反映（差分検知最適化）
      this.quill.on('text-change', (delta, oldDelta, source) => {
        if (source !== 'user') return;

        const rawText = this.quill.getText();
        const text = rawText.endsWith('\n') ? rawText.slice(0, -1) : rawText;
        const curItem = this.selectedItem;

        if (curItem && curItem.type === 'text') {
          const activeKf = getActiveKeyframe(curItem);
          const prevText = activeKf ? activeKf.text : curItem.text;

          if (activeKf) {
            activeKf.text = text;
            if (activeKf.time === 0) curItem.text = text;
          } else {
            curItem.text = text;
          }

          const format = this.quill.getFormat();
          if (format.color) curItem.color = format.color;
          if (format.font) {
            curItem.fontFamily = window.ScriptDSL ? window.ScriptDSL.getFamilyFromQuill(format.font) : 'M PLUS Rounded 1c';
          }

          // キャッシュの無効化
          curItem._cachedLines = null;
          curItem._lastTextCacheKey = null;

          const quickText = document.getElementById('clip-quick-text');
          if (quickText && document.activeElement !== quickText) {
            quickText.value = text;
          }

          this.renderCaptionCueList();

          // テキスト内容が実際に変わった時のみタイムラインラベルを同期
          if (prevText !== text) {
            const domEl = this._clipDomMap.get(curItem.id);
            if (domEl) {
              const span = domEl.querySelector('span');
              if (span) span.innerText = text || curItem.name || 'テキスト';
            }
          }
          this.requestRender();
        }
      });

      const cueBtn = document.getElementById('btn-add-text-cue');
      if (cueBtn) {
        cueBtn.onclick = () => {
          const cur = this.selectedItem;
          if (cur?.type !== 'text') return;

          this.saveState();
          const relSec = Math.max(0, Math.min(cur.duration, Math.round((this.state.currentTime - cur.startTime) * 100) / 100));
          if (!cur.textKeyframes) cur.textKeyframes = [{ time: 0, text: cur.text || 'テキスト' }];

          const existing = cur.textKeyframes.find(k => Math.abs(k.time - relSec) < 0.05);
          const currentInputText = this.quill ? this.quill.getText().trim() : 'テキスト';

          if (existing) existing.text = currentInputText || '変化後テキスト';
          else {
            cur.textKeyframes.push({ time: relSec, text: currentInputText || '変化後テキスト' });
            cur.textKeyframes.sort((a, b) => a.time - b.time);
          }

          this.renderCaptionCueList();
          this.notifyUpdate({ duration: false, toolbar: false });
        };
      }
    }

    // パネルが開かれた時、現在の時間に対応するキーフレームのテキストをQuillに流し込む
    if (item && item.type === 'text') {
      this.quill.enable(true);

      // ★ 縁取り・二重フチ・グラデーション・光彩 UIの完全同期
      const strokeEnabled = item.strokeEnabled !== undefined ? item.strokeEnabled : true;
      const strokeColor = item.strokeColor || '#000000';
      const strokeWidth = item.strokeWidth !== undefined ? item.strokeWidth : 6;

      const setElVal = (id, val, isCheck = false) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (isCheck) el.checked = !!val;
        else el.value = val;
      };

      setElVal('text-stroke-enabled', strokeEnabled, true);
      setElVal('text-stroke-color', strokeColor);
      setElVal('text-stroke-width', strokeWidth);
      const valW = document.getElementById('val-text-stroke-width');
      if (valW) valW.innerText = `${strokeWidth}px`;

      // 第2フチ (二重フチ)
      setElVal('text-stroke2-enabled', item.stroke2Enabled, true);
      setElVal('text-stroke2-color', item.stroke2Color || '#ff0000');
      setElVal('text-stroke2-width', item.stroke2Width || 14);
      const valW2 = document.getElementById('val-text-stroke2-width');
      if (valW2) valW2.innerText = `${item.stroke2Width || 14}px`;

      // グラデーション
      setElVal('text-grad-enabled', item.gradientEnabled, true);
      setElVal('text-grad-color1', item.gradientColor1 || '#ffffff');
      setElVal('text-grad-color2', item.gradientColor2 || '#ffcc00');

      // ネオン光彩
      setElVal('text-glow-enabled', item.glowEnabled, true);
      setElVal('text-glow-color', item.glowColor || '#00f0ff');
      setElVal('text-glow-blur', item.glowBlur || 15);
      const valGlow = document.getElementById('val-text-glow-blur');
      if (valGlow) valGlow.innerText = `${item.glowBlur || 15}px`;

      const activeKf = getActiveKeyframe(item);
      const currentText = activeKf ? activeKf.text : (item.text || '');

      this.quill.setText(currentText || '');
      const len = (currentText || '').length;
      if (len > 0) {
        if (item.color) this.quill.formatText(0, len, 'color', item.color);
        const quillFont = window.ScriptDSL ? window.ScriptDSL.getQuillFromFamily(item.fontFamily) : 'sans-serif';
        this.quill.formatText(0, len, 'font', quillFont);
      }
      this.renderCaptionCueList();
    } else {
      this.quill.setText('');
      this.quill.enable(false);
      this.renderCaptionCueList();
    }
  }

  // 字幕キーフレームリスト (Cue List) の描画
  renderCaptionCueList() {
    const listEl = document.getElementById('caption-cue-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const item = this.selectedItem;
    if (!item?.textKeyframes || item.textKeyframes.length === 0) {
      listEl.innerHTML = '<span style="font-size:10px; color:var(--text-sub);">キーフレームはありません（全編同一テキスト）</span>';
      return;
    }

    const relSec = Math.max(0, this.state.currentTime - item.startTime);

    item.textKeyframes.forEach((kf, idx) => {
      const nextKf = item.textKeyframes[idx + 1];
      const isActive = relSec >= kf.time && (!nextKf || relSec < nextKf.time);

      const row = document.createElement('div');
      row.className = `caption-cue-item ${isActive ? 'active' : ''}`;
      row.style.cursor = 'pointer';
      row.innerHTML = `<span class="caption-cue-time">${kf.time.toFixed(1)}s</span><span class="caption-cue-text">${kf.text.replace(/\n/g, ' ')}</span>${item.textKeyframes.length > 1 ? '<button class="btn btn-secondary btn-del-mini">✕</button>' : ''}`;

      row.onclick = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        this.seekTo(item.startTime + kf.time, true);
        this.initQuillEditor();
      };

      const delBtn = row.querySelector('button');
      if (delBtn) {
        delBtn.onclick = (e) => {
          e.stopPropagation();
          this.saveState();
          item.textKeyframes = item.textKeyframes.filter(k => k !== kf);
          if (item.textKeyframes.length <= 1) {
            if (item.textKeyframes.length === 1) item.text = item.textKeyframes[0].text;
            item.textKeyframes = null;
          }
          this.initQuillEditor();
          this.notifyUpdate({ duration: false, toolbar: false });
        };
      }
      listEl.appendChild(row);
    });
  }
  update3DMaterialAndAnim() {
    if (!this.selectedItem || this.selectedItem.type !== '3d') return;
    const clip = this.selectedItem;

    const getVal = (id, scale = 1) => (parseFloat(document.getElementById(id)?.value) || 0) * scale;
    const setBadge = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };

    const opacity = getVal('3d-opacity', 0.01);
    const emissiveIntensity = getVal('3d-emissive', 0.01);
    const metalness = getVal('3d-metalness', 0.01);
    const roughness = getVal('3d-roughness', 0.01);
    const particleSize = getVal('3d-particle-size', 0.01);

    setBadge('val-3d-opacity', `${Math.round(opacity * 100)}%`);
    setBadge('val-3d-emissive', `${Math.round(emissiveIntensity * 100)}%`);
    setBadge('val-3d-metalness', `${Math.round(metalness * 100)}%`);
    setBadge('val-3d-roughness', `${Math.round(roughness * 100)}%`);
    setBadge('val-3d-particle-size', `${Math.round(particleSize * 100)}px`);

    const gradientEnabled = !!document.getElementById('3d-gradient-enabled')?.checked;
    document.getElementById('3d-gradient-group')?.classList.toggle('hidden', !gradientEnabled);

    clip.materialProps = {
      color: document.getElementById('3d-color').value,
      opacity, emissiveIntensity, metalness, roughness, particleSize,
      wireframe: document.getElementById('3d-wireframe').checked,
      shaderType: document.getElementById('3d-shader-type')?.value || 'standard',
      gradientEnabled,
      gradientColor1: document.getElementById('3d-grad-color1')?.value || '#00f0ff',
      gradientColor2: document.getElementById('3d-grad-color2')?.value || '#7928ca'
    };

    if (clip.model && this.threeEngine) {
      this.threeEngine.applyMaterialProps(clip.model, clip.materialProps);
    }
    this.requestRender();
  }

  // ★ 動画から音声を独立した音声クリップとして分離
  separateAudioFromVideo() {
    if (this.selectedItems.length === 0) return;
    const videoClip = this.selectedItems[0];

    if (!videoClip || videoClip.type !== 'video' || !videoClip.element) {
      alert("音声を分離したい動画素材を選択してください。");
      return;
    }

    if (videoClip.isAudioSeparated) {
      alert("この動画はすでに音声が分離されています。");
      return;
    }

    this.saveState();

    // 1. 元の動画を消音化（映像専用クリップにする）
    videoClip.isAudioSeparated = true; // 音声分離済みフラグ
    videoClip.element.muted = true;
    videoClip.element.volume = 0;
    if (videoClip.element._mediaGainNode && this.audioCtx) {
      videoClip.element._mediaGainNode.gain.setValueAtTime(0, this.audioCtx.currentTime);
    }
    const originalWaveform = videoClip.waveform;
    videoClip.waveform = null; // 動画側の波形表示を解除

    // 2. 独立した音声再生用 Audio 要素を新規生成
    const audio = new Audio(videoClip.element.src);
    audio.preload = 'auto';
    audio.playbackRate = videoClip.element.playbackRate || 1.0;
    audio.volume = this.state.volume.bgm;
    audio.muted = false;

    // 3. 空いているトラック（通常は1段下など）を自動選定
    const audioTrackIdx = this.getAvailableTrackIndex(videoClip.startTime, videoClip.duration);

    const newAudioClip = {
      id: 'audio-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      type: 'audio',
      element: audio,
      startTime: videoClip.startTime,
      duration: videoClip.duration,
      originalDuration: videoClip.originalDuration || videoClip.duration,
      mediaOffset: videoClip.mediaOffset || 0,
      trackIndex: audioTrackIdx,
      name: `${videoClip.name || '動画'} (音声)`,
      waveform: originalWaveform || null
    };

    if (this._mediaRegistry) {
      this._mediaRegistry.set(newAudioClip.id, { element: audio, model: null, waveform: originalWaveform });
    }

    this.state.tracks.push(newAudioClip);

    // 波形がまだない場合はバックグラウンドで波形を非同期生成（大容量ファイル保護付き）
    if (!originalWaveform && videoClip.element && videoClip.element.src) {
      fetch(videoClip.element.src)
        .then(res => {
          if (!res.ok) throw new Error("Fetch failed");
          const contentLength = res.headers.get('content-length');
          // 100MB 以上の大容量ファイルはメモリ破綻を防ぐため波形自動生成をスキップ
          if (contentLength && parseInt(contentLength, 10) > 100 * 1024 * 1024) {
            throw new Error("大容量ファイルのため波形生成をスキップしました");
          }
          return res.blob();
        })
        .then(blob => {
          if (blob.size > 100 * 1024 * 1024) {
            throw new Error("大容量ファイルのため波形生成をスキップしました");
          }
          const file = new File([blob], "audio.wav", { type: "audio/wav" });
          return this.generateWaveformCanvas(file, this.state.volume.bgm);
        })
        .then(wf => {
          if (wf && newAudioClip) {
            newAudioClip.waveform = wf;
            this.setupTimelineUI();
          }
        })
        .catch(err => {
          console.warn("音声分離時の波形生成をスキップ:", err.message);
        });
    }

    // 4. UI と画面の更新
    this.selectedItems = [newAudioClip];
    this.updateContextualToolbar();
    this.setupTimelineUI();
    this.updateVolume();
    this.requestRender();
  }

  splitSelectedItem() {
    if (this.selectedItems.length === 0) return;
    const clip = this.selectedItems[0];

    if (typeof clip.startTime !== 'number') return;

    const relTime = this.state.currentTime - clip.startTime;

    // クリップの範囲内に再生針がある場合のみ分割
    if (relTime > 0.1 && relTime < clip.duration - 0.1) {
      this.pause();
      this.saveState();
      const pitch = this.state.volume.pitch || 1.0;
      const originalDuration = clip.duration;
      const originalOffset = clip.mediaOffset || 0;
      clip.duration = relTime; // 前半部分の長さを確定
      clip.originalDuration = relTime * pitch;

      // ★ 動画・音声・3Dモデルの独立した要素を新しく生成（取り合いバグを完全防止）
      let newElement = null;
      let newModel = null;

      if (clip.type === 'video' && clip.element) {
        newElement = document.createElement('video');
        newElement.playsInline = true;
        newElement.style.display = 'none';
        newElement.src = clip.element.src;
        newElement.preload = 'auto';
        newElement.playbackRate = clip.element.playbackRate || 1.0;
        newElement.volume = clip.element.volume;
        newElement.muted = clip.element.muted;
        document.body.appendChild(newElement);
      } else if (clip.type === 'audio' && clip.element) {
        newElement = new Audio(clip.element.src);
        newElement.preload = 'auto';
        newElement.playbackRate = clip.element.playbackRate || 1.0;
        newElement.volume = clip.element.volume;
        newElement.muted = clip.element.muted;
      } else if (clip.type === '3d' && clip.model) {
        newModel = clip.model.clone(true);
        newModel.traverse((child) => {
          if (child.isMesh && child.material) {
            child.material = Array.isArray(child.material)
              ? child.material.map(m => m.clone())
              : child.material.clone();
          }
          if (child.isPoints) {
            if (child.material) {
              child.material = child.material.clone();
            }
            if (child.geometry) {
              child.geometry = child.geometry.clone();
            }
            const origUserData = clip.model.userData || child.userData || {};
            child.userData = {
              particleType: origUserData.particleType || 'fire',
              basePositions: origUserData.basePositions ? new Float32Array(origUserData.basePositions) : null
            };
            newModel.userData = { ...child.userData };
          }
        });
        this.threeScene.add(newModel);
      } else if (clip.type === 'image' && clip.element) {

        newElement = clip.element; // 画像は静止画のため共有で安全
      }

      let newInnerMedia = null;
      if (clip.innerMediaElement && clip.innerMediaElement.tagName === 'VIDEO') {
        newInnerMedia = document.createElement('video');
        newInnerMedia.playsInline = true;
        newInnerMedia.muted = true;
        newInnerMedia.loop = true;
        newInnerMedia.src = clip.innerMediaElement.src;
      } else if (clip.innerMediaElement) {
        newInnerMedia = clip.innerMediaElement;
      }

      const { element, model, mixer, waveform, _audioSourceNode, _audioNodes, _mediaGainNode, _mediaElementSourceNode, _animResultBuffer, _kfResultBuffer, _finalTransformBuffer, ...safeProps } = clip;
      const clonedProps = JSON.parse(JSON.stringify(safeProps));

      // 分割時のフェード設定の最適配分（前半: フェードイン維持 / 後半: フェードアウト維持）
      const origFadeOut = clip.audioFadeOut || 0;
      clip.audioFadeOut = 0; // 前半は分割点でのフェードアウトを解除

      const remainingDuration = originalDuration - relTime;

      // ★ キーフレームテキストの分割：前半に残すキーフレームと後半に引き継ぐキーフレームを分離
      let firstKeyframes = null;
      let secondKeyframes = null;

      if (Array.isArray(clip.textKeyframes) && clip.textKeyframes.length > 0) {
        // 前半クリップ用（relTime より前のキーフレーム）
        firstKeyframes = clip.textKeyframes.filter(k => k.time < relTime);
        if (firstKeyframes.length === 0) {
          firstKeyframes = [{ time: 0, text: clip.text || '' }];
        }

        // 後半クリップ用（relTime 以降のキーフレームを 0 秒基準にシフト）
        const afterKfs = clip.textKeyframes.filter(k => k.time >= relTime);
        const activeAtSplit = clip.textKeyframes.slice().reverse().find(k => k.time <= relTime);

        secondKeyframes = [
          { time: 0, text: activeAtSplit ? activeAtSplit.text : (clip.text || '') }
        ];

        afterKfs.forEach(k => {
          const rawShift = Math.round((k.time - relTime) * 100) / 100;
          if (rawShift <= 0.05) {
            secondKeyframes[0].text = k.text;
          } else {
            const shiftedTime = Math.max(0.05, rawShift);
            if (!secondKeyframes.some(sk => Math.abs(sk.time - shiftedTime) < 0.05)) {
              secondKeyframes.push({ time: shiftedTime, text: k.text });
            }
          }
        });
        secondKeyframes.sort((a, b) => a.time - b.time);

        clip.textKeyframes = firstKeyframes;
      }

      // ★ クリップ内マーカーの分割・シフト処理
      let firstMarkers = null;
      let secondMarkers = null;
      if (Array.isArray(clip.markers) && clip.markers.length > 0) {
        firstMarkers = clip.markers.filter(m => m.time < relTime);
        secondMarkers = clip.markers
          .filter(m => m.time >= relTime)
          .map(m => ({ ...m, time: Math.max(0, m.time - relTime) }));
        clip.markers = firstMarkers.length > 0 ? firstMarkers : undefined;
      }

      const newClip = {
        ...clonedProps,
        id: 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        startTime: clip.startTime + relTime,
        mediaOffset: originalOffset + (relTime * pitch),
        duration: remainingDuration,
        originalDuration: remainingDuration * pitch,
        trackIndex: clip.trackIndex !== undefined ? clip.trackIndex : 0,
        audioFadeIn: 0,
        audioFadeOut: origFadeOut,
        element: newElement,
        model: newModel,
        innerMediaElement: newInnerMedia,
        waveform: clip.waveform || null,
        textKeyframes: secondKeyframes,
        markers: secondMarkers && secondMarkers.length > 0 ? secondMarkers : undefined,
        text: secondKeyframes ? secondKeyframes[0].text : clip.text,
        transform: clip.transform ? { ...clip.transform } : undefined
      };

      if (this._mediaRegistry) {
        this._mediaRegistry.set(clip.id, { element: clip.element, model: clip.model, waveform: clip.waveform });
        this._mediaRegistry.set(newClip.id, { element: newElement, model: newModel, waveform: clip.waveform });
      }

      this.state.tracks.push(newClip);
      this.selectedItems = [newClip];

      this.notifyUpdate(); // 1行で安全同期
    } else {
      alert("分割するには、素材の途中に再生バー（赤針）を合わせてください。");
    }
  }

  // ★ 選択された2つの素材の間にトランジションを自動設定
  applyTransitionBetweenSelected(type, duration) {
    if (this.selectedItems.length !== 2) {
      alert("トランジションを設定するには、2つの素材を選択してください。");
      return;
    }

    this.saveState();

    // 時間順にクリップA（前）とクリップB（後）を並び替え
    const sorted = [...this.selectedItems].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    window.AnimationEngine.applyTransition(sorted[0], sorted[1], type, duration);

    // タイムライン全体の総尺を再計算
    this.recalculateTotalDuration();

    // 2つのクリップの境目（切り替え地点）へ再生バーをジャンプさせてプレビュー
    const transitionPoint = Math.max(0, sorted[1].startTime);
    this.seekTo(Math.max(0, transitionPoint - 0.5), true);

    this.setupTimelineUI();
    this.requestRender();
  }

  // ★ 2. 結合・複合クリップ化機能 (同種連結 ＆ 異種素材グループ化 両対応)
  mergeSelectedItems() {
    if (this.selectedItems.length < 2) {
      alert("統合するには、Shiftキーを押しながら素材を2つ以上選択してください。");
      return;
    }

    this.saveState();
    // 開始時間順に並び替え
    this.selectedItems.sort((a, b) => a.startTime - b.startTime);

    const firstType = this.selectedItems[0].type;
    const isSameType = this.selectedItems.every(item => item.type === firstType);

    const minStartTime = Math.min(...this.selectedItems.map(i => i.startTime || 0));
    const maxEndTime = Math.max(...this.selectedItems.map(i => (i.startTime || 0) + (i.duration || 0)));
    const totalDuration = maxEndTime - minStartTime;
    const idsToRemove = this.selectedItems.map(item => item.id);

    if (isSameType && firstType === 'text') {
      // (1) テキスト同士：1つのテキストクリップに文章を改行結合
      const firstClip = this.selectedItems[0];
      firstClip.text = this.selectedItems.map(i => i.text || '').join('\n');
      firstClip.startTime = minStartTime;
      firstClip.duration = totalDuration;

      const removedClips = this.selectedItems.slice(1);
      removedClips.forEach(c => this.disposeClip(c));
      this.state.tracks = this.state.tracks.filter(c => !removedClips.some(r => r.id === c.id));
      this.selectedItems = [firstClip];
    } else {
      // (2) 異種素材（画像+音声、文字+図形等）：複合クリップ(group)として1本にパッケージ化
      const groupChildren = this.selectedItems.map(item => ({
        ...item,
        relativeStart: (item.startTime || 0) - minStartTime
      }));

      const compoundClip = {
        id: 'group-' + Date.now(),
        type: 'group',
        name: `複合グループ (${this.selectedItems.length}素材)`,
        startTime: minStartTime,
        duration: totalDuration,
        trackIndex: this.selectedItems[0].trackIndex || 0,
        children: groupChildren,
        transform: { scale: 1.0, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 }
      };

      // 元の個別クリップをトラックから除外（複合クリップに置換）
      this.state.tracks = this.state.tracks.filter(c => !idsToRemove.includes(c.id));
      this.state.tracks.push(compoundClip);
      this.selectedItems = [compoundClip];
    }

    this.notifyUpdate(); // 1行で安全同期
  }

  copySelectedItem() {
    if (this.selectedItems.length === 0) return;

    // 複数素材の位置関係（開始時間の差）を記憶
    const baseStartTime = Math.min(...this.selectedItems.map(i => i.startTime || 0));

    this.clipboard = this.selectedItems.map(item => {
      const { element, model, mixer, waveform, _audioSourceNode, innerMediaElement, ...safeProps } = item;
      return {
        ...JSON.parse(JSON.stringify(safeProps)),
        children: Array.isArray(item.children) ? JSON.parse(JSON.stringify(item.children)) : undefined,
        relativeOffset: (item.startTime || 0) - baseStartTime,
        element: item.element || null,
        model: item.model || null,
        waveform: item.waveform || null,
        innerMediaElement: item.innerMediaElement || null,
        songMakerData: item.songMakerData ? JSON.parse(JSON.stringify(item.songMakerData)) : null,
        audioFadeIn: item.audioFadeIn || 0,
        audioFadeOut: item.audioFadeOut || 0,
        origVolume: item.element ? item.element.volume : 1.0,
        origPlaybackRate: item.element ? item.element.playbackRate : 1.0
      };
    });

    alert(`${this.clipboard.length}個の素材をまとめてコピーしました。`);
  }
  pasteItem() {
    if (!this.clipboard || this.clipboard.length === 0) {
      alert("コピーされた素材がありません。");
      return;
    }
    this.saveState();

    const pastedClips = [];

    // コピーされた全素材の位置関係を保ったまま赤針の位置へ一括ペースト
    this.clipboard.forEach(clipData => {
      let newElement = null;
      let clonedModel = null;

      // 動画・音声は新規DOM要素を作成して参照の取り合いを防止
      if (clipData.type === 'video' && clipData.element) {
        newElement = document.createElement('video');
        newElement.playsInline = true;
        newElement.style.display = 'none';
        newElement.src = clipData.element.src;
        newElement.preload = 'auto';
        newElement.playbackRate = clipData.element.playbackRate || 1.0;
        newElement.volume = clipData.element.volume;
        newElement.muted = clipData.element.muted;
        document.body.appendChild(newElement);
      } else if (clipData.type === 'audio' && clipData.element) {
        newElement = new Audio(clipData.element.src);
        newElement.preload = 'auto';
        newElement.playbackRate = clipData.origPlaybackRate || clipData.element.playbackRate || 1.0;
        newElement.volume = clipData.origVolume !== undefined ? clipData.origVolume : clipData.element.volume;
        newElement.muted = clipData.element.muted;
        newElement.preservesPitch = false;
        if ('webkitPreservesPitch' in newElement) newElement.webkitPreservesPitch = false;
      } else if (clipData.type === 'image' && clipData.element) {
        newElement = clipData.element;
      }

      // 3Dモデルのディープクローン
      if (clipData && clipData.model && typeof clipData.model.clone === 'function') {
        clonedModel = clipData.model.clone(true);
        clonedModel.traverse((child) => {
          if (child.isMesh && child.material) {
            child.material = child.material.clone();
          }
        });
        this.threeScene.add(clonedModel);
      }

      const { element, model, ...safeData } = clipData;

      const newClip = {
        ...JSON.parse(JSON.stringify(safeData)),
        id: 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        children: Array.isArray(clipData.children) ? JSON.parse(JSON.stringify(clipData.children)) : undefined,
        startTime: this.state.currentTime + (clipData.relativeOffset || 0),
        audioFadeIn: clipData.audioFadeIn || 0,
        audioFadeOut: clipData.audioFadeOut || 0,
        songMakerData: clipData.songMakerData ? JSON.parse(JSON.stringify(clipData.songMakerData)) : null,
        element: newElement,
        model: clonedModel,
        waveform: clipData.waveform || null,
        innerMediaElement: clipData.innerMediaElement || null,
        // ★ 物理設定のディープコピー
        physics: clipData.physics ? { ...clipData.physics } : { enabled: true, bounciness: 0.4, isStatic: false },
        textKeyframes: Array.isArray(clipData.textKeyframes) ? JSON.parse(JSON.stringify(clipData.textKeyframes)) : undefined
      };

      if (this._mediaRegistry) {
        this._mediaRegistry.set(newClip.id, { element: newElement, model: clonedModel, waveform: clipData.waveform });
      }

      this.state.tracks.push(newClip);
      pastedClips.push(newClip);
    });

    this.selectedItems = pastedClips;
    this.recalculateTotalDuration();
    this.updateSelectedClipTimeUI(); // ★ ペーストした素材のIN/OUT情報を即座に表示
    this.updateVolume();             // ★ ペーストした音声の音量・ピッチを即時同期
    this.updateContextualToolbar();
    this.setupTimelineUI();
    this.requestRender();
  }

  /**
   * 素材削除時の安全な一時停止および3Dシーン除外（GPUリソース完全解放対応）
   */
  disposeClip(item) {
    if (!item) return;

    // 削除フラグを立てて renderLoop からのアクセスを即時遮断
    item._isDisposed = true;

    // メディア要素は一時停止してDOMから取り外すのみ（Undo復元用にsrcや_mediaRegistryは保持）
    if (item.element) {
      try {
        if (typeof item.element.pause === 'function') item.element.pause();
      } catch (e) {}
      try {
        if (item.element.parentNode) {
          item.element.parentNode.removeChild(item.element);
        }
      } catch (e) {}
    }

    // 図形内動画の停止と除去
    if (item.innerMediaElement && item.innerMediaElement.tagName === 'VIDEO') {
      try { item.innerMediaElement.pause(); } catch (e) {}
      if (item.innerMediaElement.parentNode) {
        item.innerMediaElement.parentNode.removeChild(item.innerMediaElement);
      }
    }

    // タイムラインDOMマップキャッシュからの除去
    if (this._clipDomMap && item.id) {
      const el = this._clipDomMap.get(item.id);
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
      this._clipDomMap.delete(item.id);
    }

    // 3Dモデルのシーン除外とGPUメモリ(VRAM)の破棄
    if (item.model && this.threeEngine) {
      this.threeEngine.disposeModel(item.model);
    }
  }
// ★ リップル削除 (区間マージアルゴリズムでトラック別に正味の削除時間幅を計算して手前に詰める)
  rippleDeleteSelectedItem() {
    if (this.selectedItems.length === 0) return;
    this.saveState();

    const idsToRemove = new Set(this.selectedItems.map(i => i.id));
    const trackIntervalsMap = new Map();
    let minDeletedStart = Infinity;

    // トラック別に削除対象区間を振り分け
    this.selectedItems.forEach(item => {
      const trk = item.trackIndex ?? 0;
      const start = item.startTime || 0;
      const end = start + (item.duration || 0);

      if (start < minDeletedStart) minDeletedStart = start;

      if (!trackIntervalsMap.has(trk)) trackIntervalsMap.set(trk, []);
      trackIntervalsMap.get(trk).push({ start, end });

      this.disposeClip(item);
    });

    if (minDeletedStart === Infinity) minDeletedStart = 0;

    // トラックごとに独立して区間をマージし、同一トラック内の後続クリップのみをシフト
    trackIntervalsMap.forEach((rawIntervals, trkIdx) => {
      rawIntervals.sort((a, b) => a.start - b.start);
      const mergedIntervals = [];

      rawIntervals.forEach(cur => {
        if (mergedIntervals.length === 0) {
          mergedIntervals.push({ ...cur });
        } else {
          const prev = mergedIntervals[mergedIntervals.length - 1];
          if (cur.start <= prev.end) {
            prev.end = Math.max(prev.end, cur.end);
          } else {
            mergedIntervals.push({ ...cur });
          }
        }
      });

      this.state.tracks.forEach(track => {
        const curTrk = track.trackIndex ?? 0;
        if (curTrk === trkIdx && !idsToRemove.has(track.id)) {
          let shift = 0;
          for (let k = 0; k < mergedIntervals.length; k++) {
            const inv = mergedIntervals[k];
            if (track.startTime >= inv.end) {
              shift += (inv.end - inv.start);
            } else if (track.startTime >= inv.start) {
              shift += (track.startTime - inv.start);
            }
          }
          track.startTime = Math.max(0, track.startTime - shift);
        }
      });
    });

    this.state.tracks = this.state.tracks.filter(c => !idsToRemove.has(c.id));
    this.selectedItems = [];

    // ★ 総尺を即座に再計算してタイムライン幅を詰める
    this.recalculateTotalDuration();
    this.notifyUpdate();
    this.seekTo(minDeletedStart, true);
  }
  // ★ 選択素材の表示 / 非表示（有効 / 無効）切り替え（最適化版）
  toggleSelectedItemVisibility() {
    if (!this.selectedItems || this.selectedItems.length === 0) return;
    this.saveState();

    const targetState = !this.selectedItems[0].hidden;
    for (let i = 0; i < this.selectedItems.length; i++) {
      const item = this.selectedItems[i];
      item.hidden = targetState;

      if (item.hidden) {
        if (item.element && !item.element.paused) {
          try { item.element.pause(); } catch (e) {}
        }
        if (item.innerMediaElement && !item.innerMediaElement.paused) {
          try { item.innerMediaElement.pause(); } catch (e) {}
        }
      }

      // DOMクラスをピンポイントで切り替え
      const domEl = this._clipDomMap.get(item.id);
      if (domEl) {
        domEl.classList.toggle('is-muted-clip', targetState);
      }
    }

    this.updateContextualToolbar();
    this.requestRender();
  }
  // ★ 素材削除処理（録画動画・全メディア完全対応版）
  deleteSelectedItem() {
    if (!this.selectedItems || this.selectedItems.length === 0) return;
    this.saveState();

    const idsToRemove = new Set(this.selectedItems.map(i => String(i.id || i)));

    for (let i = 0; i < this.selectedItems.length; i++) {
      this.disposeClip(this.selectedItems[i]);
    }

    // タイムラインDOMから即座に要素を除去
    idsToRemove.forEach(id => {
      const domEl = this._clipDomMap.get(id);
      if (domEl) {
        if (domEl.parentNode) domEl.parentNode.removeChild(domEl);
        this._clipDomMap.delete(id);
      }
    });

    // 削除対象以外のクリップのトランジション調整
    const tracks = this.state.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (!idsToRemove.has(String(track.id)) && track.animProps) {
        if (track.animProps.inAnim === 'fadeIn' || track.animProps.inAnim === 'crossfade') track.animProps.inAnim = 'none';
        if (track.animProps.outAnim === 'fadeOut' || track.animProps.outAnim === 'crossfade') track.animProps.outAnim = 'none';
      }
    }

    this.state.tracks = tracks.filter(c => !idsToRemove.has(String(c.id)));
    this.selectedItems = [];

    this.notifyUpdate();
  }
  // ★ 素材の複製 (コピー・最適化版)
  duplicateSelectedItem() {
    if (!this.selectedItem) return;
    this.saveState();

    const clip = this.selectedItem;
    const newId = 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

    let newElement = null;
    let newModel = null;

    // メディア要素の独立した複製
    if (clip.type === 'video' && clip.element) {
      newElement = document.createElement('video');
      newElement.playsInline = true;
      newElement.style.display = 'none';
      newElement.src = clip.element.src;
      newElement.preload = 'auto';
      newElement.playbackRate = clip.element.playbackRate || 1.0;
      newElement.volume = clip.element.volume;
      newElement.muted = clip.element.muted;
      document.body.appendChild(newElement);
    } else if (clip.type === 'audio' && clip.element) {
      newElement = new Audio(clip.element.src);
      newElement.preload = 'auto';
      newElement.playbackRate = clip.element.playbackRate || 1.0;
      newElement.volume = clip.element.volume;
      newElement.muted = clip.element.muted;
      newElement.preservesPitch = false;
      if ('webkitPreservesPitch' in newElement) newElement.webkitPreservesPitch = false;
    } else if (clip.type === 'image' && clip.element) {
      newElement = clip.element;
    } else if (clip.type === '3d' && clip.model) {
      newModel = clip.model.clone(true);
      newModel.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material = Array.isArray(child.material) 
            ? child.material.map(m => m.clone()) 
            : child.material.clone();
        }
        if (child.isPoints) {
          if (child.material) {
            child.material = child.material.clone();
          }
          if (child.geometry) {
            child.geometry = child.geometry.clone();
          }
          const origUserData = clip.model.userData || child.userData || {};
          child.userData = {
            particleType: origUserData.particleType || 'fire',
            basePositions: origUserData.basePositions ? new Float32Array(origUserData.basePositions) : null
          };
          newModel.userData = { ...child.userData };
        }
      });


      // ★ ボーンアニメーションを持つモデルの場合、Mixer も独立して再生成
      let newMixer = null;
      const animClips = clip.model.animations || (clip.mixer ? clip.mixer._actions?.map(a => a.getClip()) : null);
      if (animClips && animClips.length > 0 && window.THREE) {
        newMixer = new THREE.AnimationMixer(newModel);
        animClips.forEach((animClip) => {
          if (animClip) newMixer.clipAction(animClip).play();
        });
      }

      this.threeScene.add(newModel);
    }

    const cloneObj = (obj) => obj ? (typeof structuredClone === 'function' ? structuredClone(obj) : JSON.parse(JSON.stringify(obj))) : undefined;
    const { element, model, mixer, waveform, _audioSourceNode, _audioNodes, _mediaGainNode, _mediaElementSourceNode, innerMediaElement, _cachedLines, _cachedTransform, _animResultBuffer, _kfResultBuffer, _finalTransformBuffer, ...safeProps } = clip;

    const newClip = {
      ...cloneObj(safeProps),
      id: newId,
      startTime: clip.startTime + clip.duration + 0.5,
      audioFadeIn: clip.audioFadeIn || 0,
      audioFadeOut: clip.audioFadeOut || 0,
      songMakerData: cloneObj(clip.songMakerData),
      element: newElement,
      model: newModel,
      waveform: clip.waveform || null,
      innerMediaElement: clip.innerMediaElement || null,
      textKeyframes: cloneObj(clip.textKeyframes),
      transform: clip.transform ? { ...clip.transform } : undefined
    };

    if (this._mediaRegistry) {
      this._mediaRegistry.set(newId, { element: newElement, model: newModel, waveform: clip.waveform });
    }

    this.state.tracks.push(newClip);
    this.selectedItems = [newClip];

    this.notifyUpdate();
  }
  initEvents() {
    // 全サブパネル共通の上端ドラッグリサイズ処理
    document.querySelectorAll('.panel-resize-handle').forEach(handle => {
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const startY = e.clientY;
        const panel = handle.closest('.sub-panel');
        if (!panel) return;
        const startHeight = panel.clientHeight;

        const onMove = (moveEvent) => {
          const deltaY = startY - moveEvent.clientY; // 上に引くと高くなる
          const newHeight = Math.max(160, Math.min(window.innerHeight * 0.75, startHeight + deltaY));
          document.documentElement.style.setProperty('--subpanel-height', `${Math.round(newHeight)}px`);
        };

        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    });

    document.getElementById('btn-shortcuts')?.addEventListener('click', () => {
      document.getElementById('panel-shortcuts')?.classList.toggle('hidden');
    });
    document.getElementById('btn-undo').addEventListener('click', () => this.undo());
    document.getElementById('btn-redo').addEventListener('click', () => this.redo());

    // プロジェクト保存イベント (JSONダウンロード)
    document.getElementById('btn-save-project')?.addEventListener('click', () => {
      const defaultName = `Project_${new Date().toISOString().slice(0, 10)}`;
      const projectName = prompt("保存するプロジェクト名を入力してください:", defaultName);
      if (projectName !== null) {
        window.ProjectManager.saveProject(this, projectName);
      }
    });

    // プロジェクト読み込みイベント (JSONインポート)
    document.getElementById('project-input')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        window.ProjectManager.loadProject(this, file);
        e.target.value = ''; // 同名ファイルの再読み込みを許可
      }
    });

    // ★ ポインター（マーカー）打刻 & 一覧パネル開閉
    document.getElementById('btn-toggle-pointer')?.addEventListener('click', () => this.addPointerMarker());
    document.getElementById('btn-add-quick-marker')?.addEventListener('click', () => this.addPointerMarker());
    document.getElementById('btn-open-markers')?.addEventListener('click', () => this.openMarkersPanel());

    // ★ 画面録画モーダル開閉 & 録画開始/停止
    document.getElementById('btn-open-screen-record')?.addEventListener('click', () => {
      document.getElementById('panel-screen-record')?.classList.remove('hidden');
    });
    document.getElementById('btn-start-record')?.addEventListener('click', () => this.startScreenRecording());
    document.getElementById('btn-stop-record')?.addEventListener('click', () => this.stopScreenRecording());

    // ウィンドウサイズ変更時にパディング再計算とタイムライン位置補正（RAFスロットリング版）
    let resizeRafId = null;
    window.addEventListener('resize', () => {
      if (!resizeRafId) {
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = null;
          this.updateTimelinePadding();
          this.updateTimelineUIOnly();
        });
      }
    });
    // ★ 基礎キーボードショートカット対応
    window.addEventListener('keydown', (e) => {
      // 入力フォーム（テキストボックスやQuillエディタ、選択メニュー）に入力中の場合はショートカットを無視
      const isInputActive = () => {
        const el = document.activeElement;
        if (!el || el === document.body) return false;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable || el.classList.contains('ql-editor')) return true;
        return false;
      };

      if (isInputActive()) return;

      const isCmdOrCtrl = e.metaKey || e.ctrlKey;

      // 0. ? キー: ショートカット一覧表示
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        const scModal = document.getElementById('panel-shortcuts');
        if (scModal) scModal.classList.toggle('hidden');
        return;
      }

      // 1. スペースキー: 再生 / 一時停止
      if (e.code === 'Space') {
        e.preventDefault();
        const smPlayBtn = document.getElementById('btn-sm-play');
        if (smPlayBtn && smPlayBtn.innerText.includes('停止')) {
          smPlayBtn.click();
        }
        this.togglePlay();
        return;
      }

      // ★ Mキー: ポインター（マーカー）打刻
      if ((e.key === 'm' || e.key === 'M') && !isCmdOrCtrl) {
        e.preventDefault();
        this.addPointerMarker();
        return;
      }

      // ★ J / K / L キー (業界標準: K=停止, L=再生/倍速, J=逆再生・巻戻し)
      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        this.pause();
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        if (!this.state.isPlaying) this.play();
        return;
      }
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        this.seekTo(Math.max(0, this.state.currentTime - 1.0), true);
        return;
      }

      // 2. Escキー: 選択解除 ＆ 開いているすべてのパネル・モーダルを一括で閉じる
      if (e.key === 'Escape') {
        this.deselectAll();
        document.querySelectorAll('.sub-panel').forEach(p => p.classList.add('hidden'));
        document.querySelectorAll('.modal-export').forEach(p => p.classList.add('hidden'));
        return;
      }

      // 3. Cキー または Sキー: 再生バー位置で分割 (PremiereのRazor / CapCutのSplit両対応)
      if (e.key === 'c' || e.key === 'C' || e.key === 's' || e.key === 'S') {
        if (!isCmdOrCtrl) {
          e.preventDefault();
          this.splitSelectedItem();
          return;
        }
      }

      // ★ Vキー: 素材の表示 / 非表示（有効 / 無効）トグル (Premiere / DaVinci 準拠)
      if (e.key === 'v' || e.key === 'V') {
        if (!isCmdOrCtrl) {
          e.preventDefault();
          this.toggleSelectedItemVisibility();
          return;
        }
      }

      // 4. Delete / Backspace: 削除 (Shift+Delete で後ろを詰めるリップル削除)
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (e.shiftKey) {
          this.rippleDeleteSelectedItem();
        } else {
          this.deleteSelectedItem();
        }
        return;
      }

      // ★ Home / End キー (タイムラインの先頭・末尾へ瞬時ジャンプ)
      if (e.key === 'Home') {
        e.preventDefault();
        this.seekTo(0, true);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        this.seekTo(this.state.duration, true);
        return;
      }

      // ★ 上下矢印キー (前後のクリップ境界線へピタッとスナップジャンプ)
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const points = [0, this.state.duration];
        this.state.tracks.forEach(c => {
          points.push(c.startTime);
          points.push(c.startTime + c.duration);
        });
        const sortedPoints = Array.from(new Set(points.map(p => Math.round(p * 100) / 100))).sort((a, b) => a - b);
        const cur = Math.round(this.state.currentTime * 100) / 100;
        
        if (e.key === 'ArrowUp') {
          // 前の境界線へ
          const prev = sortedPoints.reverse().find(p => p < cur - 0.05);
          this.seekTo(prev !== undefined ? prev : 0, true);
        } else {
          // 次の境界線へ
          const next = sortedPoints.find(p => p > cur + 0.05);
          this.seekTo(next !== undefined ? next : this.state.duration, true);
        }
        return;
      }

      // 5. 選択素材がある場合の矢印キー移動 (Alt/Optionキー または 素材選択中)
      if (this.selectedItem?.transform && (e.altKey || this.dragState.selectedClip)) {
        const step = e.shiftKey ? 10 : 1;
        const dirMap = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        const dir = dirMap[e.key];

        if (dir) {
          e.preventDefault();
          this.selectedItem.transform.x = (this.selectedItem.transform.x || 0) + dir[0];
          this.selectedItem.transform.y = (this.selectedItem.transform.y || 0) + dir[1];

          // UI値の同期
          const { x, y } = this.selectedItem.transform;
          const xEl = document.getElementById('trans-x');
          const yEl = document.getElementById('trans-y');
          if (xEl) xEl.value = x;
          if (yEl) yEl.value = y;
          const vx = document.getElementById('val-trans-x');
          const vy = document.getElementById('val-trans-y');
          if (vx) vx.innerText = `${x}px`;
          if (vy) vy.innerText = `${y}px`;

          this.requestRender();
          return;
        }
      }

      // 5.1. 素材未選択時の左右矢印キー (コマ送り / スキップ)
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const step = e.shiftKey ? 1.0 : 0.1; // Shift押しながらで1秒ジャンプ
        this.seekTo(Math.max(0, this.state.currentTime - step), true);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const step = e.shiftKey ? 1.0 : 0.1;
        this.seekTo(Math.min(this.state.duration, this.state.currentTime + step), true);
        return;
      }

      // 5.1. タイムラインズームショートカット (+ / - / =)
      if (e.key === '+' || e.key === '=' || e.key === ';') {
        e.preventDefault();
        this.setZoom(this.state.zoom * 1.25);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        this.setZoom(this.state.zoom * 0.8);
        return;
      }

      // 6. Ctrl + Z / Cmd + Z (Undo) & Ctrl + Y (Redo)
      if (isCmdOrCtrl && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) {
          this.redo();
        } else {
          this.undo();
        }
        return;
      }
      if (isCmdOrCtrl && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        this.redo();
        return;
      }

      // 7. Ctrl + S (プロジェクト保存)
      if (isCmdOrCtrl && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const defaultName = `Project_${new Date().toISOString().slice(0, 10)}`;
        const projectName = prompt("プロジェクトを保存:", defaultName);
        if (projectName !== null) {
          window.ProjectManager.saveProject(this, projectName);
        }
        return;
      }

      // 7.1. Ctrl + O (プロジェクトを開く)
      if (isCmdOrCtrl && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        document.getElementById('project-input')?.click();
        return;
      }

      // 7.2. Ctrl + A / Cmd + A (すべての素材を一括全選択)
      if (isCmdOrCtrl && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        if (this.state.tracks.length > 0) {
          this.selectedItems = [...this.state.tracks];
          this.updateContextualToolbar();
          this.setupTimelineUI();
          this.requestRender();
        }
        return;
      }

      // 7.1. Ctrl + C (コピー) & Ctrl + V (ペースト) & Ctrl + X (カット)
      if (isCmdOrCtrl && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault();
        this.copySelectedItem();
        return;
      }
      if (isCmdOrCtrl && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        this.pasteItem();
        return;
      }
      if (isCmdOrCtrl && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        this.copySelectedItem();
        this.deleteSelectedItem();
        return;
      }
    });
    document.addEventListener('pointerdown', (e) => {
      const isClip = e.target.closest('.timeline-clip');
      const isToolBtn = e.target.closest('.tool-btn');
      const isSubPanel = e.target.closest('.sub-panel');
      const isHeader = e.target.closest('.header');
      const isControl = e.target.closest('.controls');
      const isCanvas = e.target.id === 'preview-canvas'; // ★ Canvas自体は除外(別途処理)

      // 操作UI以外の何もない背景部分を触ったら即座に解除
      if (!isClip && !isToolBtn && !isSubPanel && !isHeader && !isControl && !isCanvas) {
        this.deselectAll();
        this.requestRender(); // 青枠を消すために再描画
      }
    });


    // ★ タイムコード直接数値入力（ミリ秒ジャンプ）
    this.timeInput.addEventListener('change', (e) => {
      const val = e.target.value.trim();
      let totalSeconds = 0;
      if (val.includes(':')) {
        const parts = val.split(':').map(p => parseFloat(p) || 0);
        if (parts.length === 4) {
          // hh:mm:ss:ff (30fps基準のフレーム数)
          totalSeconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2] + (parts[3] / 30);
        } else if (parts.length === 3) {
          // hh:mm:ss.ms
          totalSeconds = (parts[0] * 3600) + (parts[1] * 60) + parts[2];
        } else if (parts.length === 2) {
          // mm:ss.ms
          totalSeconds = (parts[0] * 60) + parts[1];
        }
      } else {
        totalSeconds = parseFloat(val) || 0;
      }
      totalSeconds = Math.max(0, Math.min(totalSeconds, this.state.duration));
      this.seekTo(totalSeconds, true);
    });

    const bgColorPicker = document.getElementById('bg-color-picker');
    if (bgColorPicker) {
      bgColorPicker.value = this.state.bgColor || '#000000';
      bgColorPicker.addEventListener('input', (e) => {
        this.state.bgColor = e.target.value;
        this.requestRender();
      });
      bgColorPicker.addEventListener('change', () => {
        this.saveState();
      });
    }

    // ★ 背景画像・背景動画の変更イベント
    document.getElementById('bg-image-input')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const img = new Image();
      img.onload = () => {
        this.state.bgMedia = { type: 'image', element: img };
        this.requestRender();
      };
      img.src = URL.createObjectURL(file);
    });

    document.getElementById('bg-video-input')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (this.state.bgMedia && this.state.bgMedia.type === 'video' && this.state.bgMedia.element) {
        this.state.bgMedia.element.pause();
        this.state.bgMedia.element.src = '';
      }
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.src = URL.createObjectURL(file);
      video.play();
      this.state.bgMedia = { type: 'video', element: video };
      this.requestRender();
    });

    document.getElementById('reset-bg-media-btn')?.addEventListener('click', () => {
      if (this.state.bgMedia && this.state.bgMedia.type === 'video' && this.state.bgMedia.element) {
        this.state.bgMedia.element.pause();
        this.state.bgMedia.element.src = '';
      }
      this.state.bgMedia = null;
      const imgIn = document.getElementById('bg-image-input');
      const vidIn = document.getElementById('bg-video-input');
      if (imgIn) imgIn.value = '';
      if (vidIn) vidIn.value = '';
      this.requestRender();
    });

    document.getElementById('video-input').addEventListener('change', (e) => this.loadVideoFile(e.target.files[0]));
    document.getElementById('image-input').addEventListener('change', (e) => this.loadImageFile(e.target.files[0]));
    document.getElementById('audio-input').addEventListener('change', (e) => this.loadAudioFile(e.target.files[0]));
    document.getElementById('model3d-input').addEventListener('change', (e) => this.load3DModelFile(e.target.files[0]));
    this.playBtn.addEventListener('click', () => this.togglePlay());

    // ★ 別タブへ移動した際は自動で一時停止（音ズレ・バックグラウンド負荷を防止）
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state.isPlaying) {
        this.pause();
      }
    });

    // ★ プレビュー全画面切り替えボタン
    const fsBtn = document.getElementById('btn-fullscreen-preview');
    const previewContainer = document.getElementById('drop-zone');
    if (fsBtn && previewContainer) {
      fsBtn.addEventListener('click', () => {
        const isFs = previewContainer.classList.toggle('fullscreen-mode');
        fsBtn.innerText = isFs ? '✕ 閉じる' : '⛶ 全画面';
      });
    }

    // タイムルーラー直接タップ（156pxオフセット補正ジャンプ）
    const timeRuler = document.getElementById('time-ruler');
    if (timeRuler) {
      timeRuler.addEventListener('pointerdown', (e) => {
        const rect = timeRuler.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const scrollOffset = this.timelineContainer ? this.timelineContainer.scrollLeft : 0;
        const zoom = Math.max(0.1, this.state.zoom || 60);

        if (clickX < 140) {
          return;
        }

        let targetTime = Math.max(0, (clickX - 156 + scrollOffset) / zoom);
        if (this.state.isSnapEnabled) {
          targetTime = this.applySnapping(targetTime);
        }

        const maxDuration = Math.max(0, this.state.duration || 0);
        targetTime = Math.max(0, Math.min(maxDuration, targetTime));
        this.seekTo(targetTime, true);
      });
    }

    const snapBtn = document.getElementById('btn-snap');
    if (snapBtn) {
      snapBtn.addEventListener('click', () => {
        this.state.isSnapEnabled = !this.state.isSnapEnabled;
        snapBtn.classList.toggle('active', this.state.isSnapEnabled);
        snapBtn.innerText = this.state.isSnapEnabled ? 'スナップ ON' : 'スナップ OFF';
      });
    }

    // ★ 複数選択モード切り替えボタン
    const multiBtn = document.getElementById('btn-multi-select');
    if (multiBtn) {
      multiBtn.addEventListener('click', () => {
        this.state.isMultiSelectMode = !this.state.isMultiSelectMode;
        multiBtn.classList.toggle('active', this.state.isMultiSelectMode);
        multiBtn.innerText = this.state.isMultiSelectMode ? '複数選択 ON' : '複数選択 OFF';
      });
    }

    const zoomSlider = document.getElementById('zoom-slider');
    const btnZoomIn = document.getElementById('btn-zoom-in');
    const btnZoomOut = document.getElementById('btn-zoom-out');

    if (zoomSlider) {
      zoomSlider.addEventListener('input', (e) => {
        this.setZoom(parseFloat(e.target.value));
      });
    }
    if (btnZoomIn) {
      btnZoomIn.addEventListener('click', () => {
        this.setZoom(this.state.zoom * 1.25);
      });
    }
    if (btnZoomOut) {
      btnZoomOut.addEventListener('click', () => {
        this.setZoom(this.state.zoom * 0.8);
      });
    }

    // ★ タイムライン上でのホイール操作（ズーム ＆ 水平シークスクロール）
    let initialPinchDistance = null;
    this.timelineContainer.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        // Ctrl + ホイール: 拡大 / 縮小（ズーム）
        e.preventDefault();
        const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
        this.setZoom(this.state.zoom * zoomFactor);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // Shift + ホイール または トラックパッド横スワイプ: 時間の左右移動
        e.preventDefault();
        const delta = e.shiftKey ? e.deltaY : e.deltaX;
        const timeShift = delta / (this.state.zoom * 2);
        const newTime = Math.max(0, Math.min(this.state.duration, this.state.currentTime + timeShift));
        this.seekTo(newTime, true);
      }
    }, { passive: false });

    this.timelineContainer.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        if (initialPinchDistance) {
          const factor = dist / initialPinchDistance;
          this.setZoom(this.state.zoom * (factor > 1 ? 1.05 : 0.95));
        }
        initialPinchDistance = dist;
      }
    });

    this.timelineContainer.addEventListener('touchend', () => {
      initialPinchDistance = null;
    });
    let waveformRedrawTimer = null;
    const debouncedRedrawWaveforms = () => {
      clearTimeout(waveformRedrawTimer);
      waveformRedrawTimer = setTimeout(() => {
        this.redrawAllWaveforms();
      }, 120);
    };

    const volVideo = document.getElementById('vol-video');
    if (volVideo) {
      volVideo.addEventListener('input', (e) => {
        const val = e.target.value;
        document.getElementById('val-vol-video').innerText = `${val}%`; // ★ 数値更新
        this.state.volume.video = parseFloat(val) / 100;
        this.updateVolume();
        debouncedRedrawWaveforms();
      });
      volVideo.addEventListener('change', () => {
        this.saveState();
        this.redrawAllWaveforms();
      });
    }

    const volBgm = document.getElementById('vol-bgm');
    if (volBgm) {
      volBgm.addEventListener('input', (e) => {
        const val = e.target.value;
        document.getElementById('val-vol-bgm').innerText = `${val}%`; // ★ 数値更新
        this.state.volume.bgm = parseFloat(val) / 100;
        this.updateVolume();
        debouncedRedrawWaveforms();
      });
      volBgm.addEventListener('change', () => {
        this.saveState();
        this.redrawAllWaveforms();
      });
    }

    const pitchInput = document.getElementById('pitch-rate');
    if (pitchInput) {
      pitchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        const valEl = document.getElementById('val-pitch-rate');
        if (valEl) valEl.innerText = `${val}%`;
        
        const newPitch = Math.max(0.25, Math.min(4.0, parseFloat(val) / 100));
        const prevPitch = this.state.volume.pitch || 1.0;
        this.state.volume.pitch = newPitch;
        this.updateVolume();

        // ★ ピッチに合わせて動画・音声クリップのタイムライン表示長さを直前の比率から伸縮
        if (Math.abs(prevPitch - newPitch) > 0.001) {
          const ratio = prevPitch / newPitch;
          this.state.tracks.forEach(clip => {
            if (clip.type === 'video' || clip.type === 'audio') {
              clip.duration = Math.max(0.1, (clip.duration || 1) * ratio);
              if (clip.originalDuration) {
                clip.originalDuration = clip.duration * newPitch;
              }
            }
          });
        }

        this.recalculateTotalDuration();
        this.setupTimelineUI();
        this.updateSelectedClipTimeUI();
        this.requestRender();
      });

      pitchInput.addEventListener('change', () => {
        this.saveState();
        this.recalculateTotalDuration();
        this.redrawAllWaveforms();
      });
    }

    // 音声フェードイン・フェードアウト連動
    ['fade-in', 'fade-out'].forEach(type => {
      const el = document.getElementById(`audio-${type}`);
      if (el) {
        el.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          const valEl = document.getElementById(`val-audio-${type}`);
          if (valEl) valEl.innerText = `${val.toFixed(1)}s`;
          if (this.selectedItem && (this.selectedItem.type === 'video' || this.selectedItem.type === 'audio')) {
            if (type === 'fade-in') this.selectedItem.audioFadeIn = val;
            else this.selectedItem.audioFadeOut = val;
          }
        });
        el.addEventListener('change', () => this.saveState());
      }
    });

    // ★ 3バンドEQ (低音・中音・高音) のリアルタイム連動
    ['eq-low', 'eq-mid', 'eq-high'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', (e) => {
          const val = parseFloat(e.target.value);
          const valEl = document.getElementById(`val-${id}`);
          if (valEl) valEl.innerText = `${val > 0 ? '+' : ''}${val}dB`;

          const item = this.selectedItem;
          if (item && (item.type === 'video' || item.type === 'audio')) {
            if (!item.eq) item.eq = { low: 0, mid: 0, high: 0 };
            if (id === 'eq-low') item.eq.low = val;
            else if (id === 'eq-mid') item.eq.mid = val;
            else if (id === 'eq-high') item.eq.high = val;
            this.updateClipAudioNodes(item);
          }
        });
        el.addEventListener('change', () => this.saveState());
      }
    });

    // ★ 音圧コンプレッサーのトグル連動
    document.getElementById('audio-comp-enabled')?.addEventListener('change', (e) => {
      const item = this.selectedItem;
      if (item && (item.type === 'video' || item.type === 'audio')) {
        item.compressorEnabled = e.target.checked;
        this.updateClipAudioNodes(item);
        this.saveState();
      }
    });
    // フィルターのバイパス（全体有効/無効）トグル連動
    document.getElementById('filter-bypass-toggle')?.addEventListener('change', (e) => {
      this.state.filters.enabled = e.target.checked;
      this.requestRender();
    });

    // ★ スライダーと数値バッジの双方向自動バインディングヘルパー
    const bindRangeWithBadge = (sliderId, badgeId, unit, onUpdate) => {
      const slider = document.getElementById(sliderId);
      const badge = document.getElementById(badgeId);
      if (!slider) return;
      slider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        if (badge) badge.innerText = `${val}${unit}`;
        onUpdate(val);
        this.requestRender();
      });
      slider.addEventListener('change', () => this.saveState());
    };

    // 1. カラー補正フィルター一括登録（スキーマ駆動）
    VideoEditorEngine.FILTER_SCHEMA.forEach(({ key }) => {
      const el = document.getElementById(`filter-${key}`);
      if (el) {
        el.addEventListener('input', (e) => {
          this.state.filters[key] = parseFloat(e.target.value);
          this.requestRender();
        });
        el.addEventListener('change', () => this.saveState());
      }
    });

    // ★ 映画風 3D-LUT プリセット＆カスタム .cube ファイルのイベント連動
    const lutPresetSelect = document.getElementById('filter-lut-preset');
    const customLutRow = document.getElementById('row-custom-lut-file');
    const customLutInput = document.getElementById('filter-custom-lut-input');

    if (lutPresetSelect) {
      lutPresetSelect.addEventListener('change', (e) => {
        const val = e.target.value;
        this.state.filters.lutPreset = val;
        if (customLutRow) customLutRow.classList.toggle('hidden', val !== 'custom_cube');
        this.saveState();
        this.requestRender();
      });
    }

    if (customLutInput) {
      customLutInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        try {
          const text = await file.text();
          this._customLutData = window.VideoProcessor.parseCubeLUT(text);
          this.state.filters.lutPreset = 'custom_cube';
          if (lutPresetSelect) lutPresetSelect.value = 'custom_cube';
          this.requestRender();
        } catch (err) {
          alert(".cube ファイルの解析に失敗しました: " + err.message);
        }
      });
    }

    const lutIntensitySlider = document.getElementById('filter-lut-intensity');
    if (lutIntensitySlider) {
      lutIntensitySlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value) / 100;
        this.state.filters.lutIntensity = val;
        const valEl = document.getElementById('val-filter-lut');
        if (valEl) valEl.innerText = `${Math.round(val * 100)}%`;
        this.requestRender();
      });
      lutIntensitySlider.addEventListener('change', () => this.saveState());
    }

    // 2. 2D/3D変形スライダー一括バインド（スキーマ駆動）
    const transKeySetters = {
      scale: v => v / 100,
      rotation: v => v,
      rotateX: v => v,
      rotateY: v => v,
      x: v => v,
      y: v => v
    };

    VideoEditorEngine.TRANSFORM_SCHEMA.forEach(({ id, key, unit }) => {
      bindRangeWithBadge(id, `val-${id}`, unit, (val) => {
        if (this.selectedItem?.transform) {
          const setter = transKeySetters[key] || (v => v);
          this.selectedItem.transform[key] = setter(val);
        }
      });
    });

    // ★ 物理モード切り替えイベント（アニメーション連動対応）
    document.getElementById('phys-mode-select')?.addEventListener('change', (e) => {
      if (!this.selectedItem) return;
      if (!this.selectedItem.physics) this.selectedItem.physics = { bounciness: 0.4 };

      const mode = e.target.value;
      if (mode === 'none') {
        this.selectedItem.physics.enabled = false;
        this.selectedItem.physics.isStatic = false;
        this.selectedItem.physics.isAnimated = false;
      } else if (mode === 'dynamic') {
        this.selectedItem.physics.enabled = true;
        this.selectedItem.physics.isStatic = false;
        this.selectedItem.physics.isAnimated = false;
      } else if (mode === 'animated') {
        // ★ アニメーション連動フラグをON
        this.selectedItem.physics.enabled = true;
        this.selectedItem.physics.isStatic = false;
        this.selectedItem.physics.isAnimated = true;
      } else if (mode === 'static') {
        this.selectedItem.physics.enabled = true;
        this.selectedItem.physics.isStatic = true;
        this.selectedItem.physics.isAnimated = false;
      }

      const rowBounce = document.getElementById('row-phys-bounce');
      if (rowBounce) rowBounce.classList.toggle('hidden', mode === 'none');

      this.saveState();
    });

    document.getElementById('phys-bounce-rate')?.addEventListener('input', (e) => {
      if (!this.selectedItem) return;
      if (!this.selectedItem.physics) this.selectedItem.physics = {};
      const val = parseFloat(e.target.value) / 100;
      this.selectedItem.physics.bounciness = val;
      const valEl = document.getElementById('val-phys-bounce');
      if (valEl) valEl.innerText = `${e.target.value}%`;
    });
    document.getElementById('phys-bounce-rate')?.addEventListener('change', () => this.saveState());
    // ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★

    ['3d-color', '3d-opacity', '3d-emissive', '3d-metalness', '3d-roughness', '3d-particle-size', '3d-wireframe', '3d-shader-type'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => this.update3DMaterialAndAnim());
        el.addEventListener('change', () => {
          this.saveState();
          this.update3DMaterialAndAnim();
        });
      }
    });

    // 3D設定のリセットボタン
    document.getElementById('reset-3d-btn')?.addEventListener('click', () => {
      if (!this.selectedItem || this.selectedItem.type !== '3d') return;
      this.saveState();
      this.selectedItem.materialProps = {
        color: '#00f0ff',
        opacity: 1.0,
        emissiveIntensity: 0.2,
        metalness: 0.4,
        roughness: 0.3,
        particleSize: 0.08,
        wireframe: false,
        shaderType: 'standard'
      };
      this.selectedItem.animMode = 'spin';
      this.selectedItem.animSpeed = 1.0;
      this.syncAndToggle3DPanel();
      if (this.threeEngine && this.selectedItem.model) {
        this.threeEngine.applyMaterialProps(this.selectedItem.model, this.selectedItem.materialProps);
      }
      this.requestRender();
    });
    ['anim-in-type', 'anim-main-type', 'anim-out-type'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this.updateClipAnimation());
    });

    const addMainAnimBtn = document.getElementById('btn-add-main-anim');
    if (addMainAnimBtn) {
      addMainAnimBtn.addEventListener('click', () => {
        const typeSelect = document.getElementById('add-main-anim-type');
        const selectedType = typeSelect ? typeSelect.value : 'float';
        this.addMainAnimation(selectedType, 0, 0, true);
        this.requestRender();
      });
    }

    // 自由キーフレームの打刻イベント
    document.getElementById('btn-add-keyframe')?.addEventListener('click', () => {
      if (!this.selectedItem) return;
      this.saveState();
      window.KeyframeEngine.addOrUpdateKeyframe(this.selectedItem, this.state.currentTime);
      this.renderClipKeyframeList();
      this.setupTimelineUI();
      this.requestRender();
    });

    // 速度変更イベント
    document.getElementById('clip-speed-select')?.addEventListener('change', (e) => {
      if (!this.selectedItem) return;
      this.saveState();
      const speed = parseFloat(e.target.value) || 1.0;
      window.VideoProcessor.setClipSpeed(this.selectedItem, speed);
      this.recalculateTotalDuration();
      this.setupTimelineUI();
      this.updateSelectedClipTimeUI();
      this.requestRender();
    });

    // 無音自動カット実行イベント
    document.getElementById('btn-run-silence-cut')?.addEventListener('click', () => {
      this.executeSilenceCut();
    });

    // マスク・ブレンドモード変更イベント
    document.getElementById('clip-mask-type')?.addEventListener('change', (e) => {
      if (!this.selectedItem) return;
      this.saveState();
      this.selectedItem.maskType = e.target.value;
      this.requestRender();
    });

    document.getElementById('clip-blend-mode')?.addEventListener('change', (e) => {
      if (!this.selectedItem) return;
      this.saveState();
      this.selectedItem.blendMode = e.target.value;
      this.requestRender();
    });

    // ストック素材追加イベント
    document.getElementById('btn-add-stock-sticker')?.addEventListener('click', () => {
      this.addStockSticker();
    });
    // 4. 図形追加処理
    // トランジション時間スライダー
    const transDurSlider = document.getElementById('trans-duration-slider');
    if (transDurSlider) {
      transDurSlider.addEventListener('input', (e) => {
        const valEl = document.getElementById('val-trans-duration');
        if (valEl) valEl.innerText = `${parseFloat(e.target.value).toFixed(1)}s`;
      });
    }

    // トランジション適用ボタン
    const applyTransBtn = document.getElementById('apply-transition-btn');
    if (applyTransBtn) {
      applyTransBtn.addEventListener('click', () => {
        const effectType = document.getElementById('trans-effect-type')?.value || 'crossfade';
        const duration = parseFloat(document.getElementById('trans-duration-slider')?.value) || 0.6;
        this.applyTransitionBetweenSelected(effectType, duration);
        document.getElementById('panel-transition')?.classList.add('hidden');
      });
    }

    // ★ Song Maker シーケンサー初期化 & イベント連携
    let currentScaleFreqs = this.synthEngine ? this.synthEngine.getScaleFrequencies('major', 'mid') : [];
    let melodyRows = currentScaleFreqs.length; // 11音
    let smBars = 4;
    let smSteps = smBars * 16; // 1小節あたり16ステップ (16分音符)

    // マトリクスデータ (true / false)
    let melodyGrid = Array.from({ length: melodyRows }, () => Array(smSteps).fill(false));
    let drumGrid = Array.from({ length: 2 }, () => Array(smSteps).fill(false)); // 0: スネア, 1: キック

    let isSmPlaying = false;
    let smCurrentStep = 0;
    let smTimerId = null;

    let isDrawing = false;
    let drawMode = true; // true: 塗り, false: 消し

    const handleCellInteraction = (cell, r, c, type) => {
      if (type === 'melody') {
        melodyGrid[r][c] = drawMode;
        cell.classList.toggle('active', drawMode);
        if (drawMode) {
          const inst = document.getElementById('sm-instrument')?.value || 'marimba';
          this.synthEngine.playSongMakerTone(currentScaleFreqs[r], inst);
        }
      } else {
        drumGrid[r][c] = drawMode;
        cell.classList.toggle('active', drawMode);
        if (drawMode) {
          const kit = document.getElementById('sm-drum-kit')?.value || 'electronic';
          this.synthEngine.playSongMakerDrum(r === 0 ? 'snare' : 'kick', kit);
        }
      }
    };

    const renderSongMakerGridUI = () => {
      const gridEl = document.getElementById('song-maker-grid');
      if (!gridEl) return;
      gridEl.innerHTML = '';
      gridEl.style.gridTemplateColumns = `repeat(${smSteps}, 28px)`;

      // ★ 最適化: DocumentFragment で全セルを一括バッチ追加
      const fragment = document.createDocumentFragment();

      // 1. メロディグリッド生成 (上段)
      for (let r = 0; r < melodyRows; r++) {
        for (let c = 0; c < smSteps; c++) {
          const cell = document.createElement('div');
          const isBarBoundary = (c + 1) % 4 === 0;
          cell.className = `sm-cell note-${r % 11} ${isBarBoundary ? 'bar-boundary' : ''} ${melodyGrid[r][c] ? 'active' : ''}`;
          cell.dataset.row = r;
          cell.dataset.col = c;
          cell.dataset.type = 'melody';
          fragment.appendChild(cell);
        }
      }

      // 2. ドラムグリッド生成 (下段: スネア ＆ キック)
      const drumTypes = ['drum-snare', 'drum-kick'];
      for (let d = 0; d < 2; d++) {
        for (let c = 0; c < smSteps; c++) {
          const cell = document.createElement('div');
          const isBarBoundary = (c + 1) % 4 === 0;
          cell.className = `sm-cell drum-row ${drumTypes[d]} ${isBarBoundary ? 'bar-boundary' : ''} ${drumGrid[d][c] ? 'active' : ''}`;
          cell.dataset.row = d;
          cell.dataset.col = c;
          cell.dataset.type = 'drum';
          fragment.appendChild(cell);
        }
      }

      gridEl.appendChild(fragment);

      // 親要素へのイベント委譲（リスナーを1回のみ登録して超高速化）
      if (!gridEl._hasDelegateListener) {
        gridEl._hasDelegateListener = true;

        gridEl.addEventListener('pointerdown', (e) => {
          const targetCell = e.target.closest('.sm-cell');
          if (!targetCell) return;
          const r = parseInt(targetCell.dataset.row);
          const c = parseInt(targetCell.dataset.col);
          const type = targetCell.dataset.type;
          isDrawing = true;
          drawMode = type === 'melody' ? !melodyGrid[r][c] : !drumGrid[r][c];
          handleCellInteraction(targetCell, r, c, type);
        });

        gridEl.addEventListener('pointerover', (e) => {
          if (!isDrawing) return;
          const targetCell = e.target.closest('.sm-cell');
          if (!targetCell) return;
          const r = parseInt(targetCell.dataset.row);
          const c = parseInt(targetCell.dataset.col);
          const type = targetCell.dataset.type;
          handleCellInteraction(targetCell, r, c, type);
        });
      }
    };

    window.addEventListener('pointerup', () => { isDrawing = false; });
    window.addEventListener('touchend', () => { isDrawing = false; });

    // ★ スマホ（タッチ操作）でのなぞり入力対応
    const scrollWrap = document.querySelector('.song-maker-scroll-wrap');
    if (scrollWrap) {
      scrollWrap.addEventListener('touchmove', (e) => {
        if (!isDrawing || e.touches.length === 0) return;
        const touch = e.touches[0];
        const targetEl = document.elementFromPoint(touch.clientX, touch.clientY);
        if (targetEl && targetEl.classList.contains('sm-cell')) {
          const r = parseInt(targetEl.dataset.row);
          const c = parseInt(targetEl.dataset.col);
          const type = targetEl.dataset.type;
          handleCellInteraction(targetEl, r, c, type);
        }
      }, { passive: true });
    }

    renderSongMakerGridUI();

    // テンポスライダー連動
    document.getElementById('sm-bpm')?.addEventListener('input', (e) => {
      const valEl = document.getElementById('val-sm-bpm');
      if (valEl) valEl.innerText = e.target.value;
    });

    // ★ ジャンル自動作曲ボタン（Rust/WasmまたはJSの本格エンジンで即座に楽曲をタイムライン追加）
    document.getElementById('btn-sm-gen-bgm')?.addEventListener('click', async () => {
      stopSmPlayback();
      const genre = document.getElementById('sm-auto-genre')?.value || 'lofi';
      const bpm = parseInt(document.getElementById('sm-bpm')?.value) || (genre === 'lofi' ? 85 : 120);
      const bars = smBars || 4;

      this.showLoading("本格BGMを作曲・レンダリング中...");
      try {
        const audioBuffer = this.synthEngine.generateBGM(genre, bars, bpm);
        const wavBlob = this.synthEngine.audioBufferToWavBlob(audioBuffer);
        const file = new File([wavBlob], `BGM_${genre}_${Date.now()}.wav`, { type: 'audio/wav' });

        await this.loadAudioFile(file);
        const addedClip = this.state.tracks[this.state.tracks.length - 1];
        if (addedClip) {
          // 後からフッターで「楽曲編集」を押せるようにメタデータを登録
          addedClip.songMakerData = {
            melodyGrid: JSON.parse(JSON.stringify(melodyGrid)),
            drumGrid: JSON.parse(JSON.stringify(drumGrid)),
            bpm: bpm,
            instrument: document.getElementById('sm-instrument')?.value || 'marimba',
            drumKit: document.getElementById('sm-drum-kit')?.value || 'electronic',
            bars: bars,
            genre: genre
          };
          this.selectedItems = [addedClip];
          this.updateContextualToolbar();
        }
        this.toggleSubPanel('panel-audio-gen');
      } catch (err) {
        alert("BGM生成エラー: " + err.message);
      } finally {
        this.hideLoading();
      }
    });

    // ★ 効果音 (SE) 試聴
    document.getElementById('btn-play-se-preview')?.addEventListener('click', () => {
      const seType = document.getElementById('se-preset-type')?.value || 'coin';
      const buf = this.synthEngine.generateSoundEffect(seType);
      this.synthEngine.playPreview(buf);
    });

    // ★ 効果音 (SE) をタイムラインの再生針（赤線）位置に追加
    document.getElementById('btn-add-se-timeline')?.addEventListener('click', async () => {
      const seType = document.getElementById('se-preset-type')?.value || 'coin';
      const seNameMap = {
        coin: 'コイン音', laser: 'レーザー', explosion: '爆発音',
        jump: 'ジャンプ', powerup: 'パワーアップ', hit: '打撃音',
        whoosh: '風切り音', click: '決定クリック'
      };
      const buf = this.synthEngine.generateSoundEffect(seType);
      const blob = this.synthEngine.audioBufferToWavBlob(buf);
      const file = new File([blob], `SE_${seNameMap[seType] || seType}.wav`, { type: 'audio/wav' });

      await this.loadAudioFile(file);
      this.toggleSubPanel('panel-audio-gen');
    });

    const gridEl = document.getElementById('song-maker-grid');
    let prevStep = -1;

    // ループ再生 / 停止（synthEngine 委譲版）
    const stopSmPlayback = () => {
      this.synthEngine?.stopSequencerLoop();
      prevStep = -1;
      document.querySelectorAll('.sm-cell.active-step').forEach(el => el.classList.remove('active-step'));
      const playBtn = document.getElementById('btn-sm-play');
      if (playBtn) playBtn.innerText = '再生';
    };

    const startSmPlayback = () => {
      stopSmPlayback();
      const playBtn = document.getElementById('btn-sm-play');
      if (playBtn) playBtn.innerText = '停止';

      const bpm = parseInt(document.getElementById('sm-bpm')?.value) || 120;
      const inst = document.getElementById('sm-instrument')?.value || 'marimba';
      const kit = document.getElementById('sm-drum-kit')?.value || 'electronic';

      this.synthEngine?.startSequencerLoop({
        melodyGrid, drumGrid, scaleFreqs: currentScaleFreqs, bpm, instrument: inst, drumKit: kit, totalSteps: smSteps
      }, (currentStep) => {
        if (gridEl) {
          if (prevStep >= 0) {
            gridEl.querySelectorAll(`[data-col="${prevStep}"]`).forEach(el => el.classList.remove('active-step'));
          }
          gridEl.querySelectorAll(`[data-col="${currentStep}"]`).forEach(el => el.classList.add('active-step'));
          prevStep = currentStep;
        }
      });
    };

    document.getElementById('btn-sm-play')?.addEventListener('click', () => {
      this.synthEngine?.isSmPlaying ? stopSmPlayback() : startSmPlayback();
    });

    // ★ 小節数・音階・オクターブの変更処理ヘルパー
    const updateSongMakerDimensions = () => {
      stopSmPlayback();
      const barsInput = document.getElementById('sm-bars-input');
      smBars = Math.max(1, Math.min(500, parseInt(barsInput?.value) || 4));
      smSteps = smBars * 16;

      const scaleMode = document.getElementById('sm-scale-mode')?.value || 'major';
      const octaveMode = document.getElementById('sm-octave')?.value || 'mid';
      currentScaleFreqs = this.synthEngine.getScaleFrequencies(scaleMode, octaveMode);
      melodyRows = currentScaleFreqs.length;

      melodyGrid = Array.from({ length: melodyRows }, (_, r) => {
        const oldRow = melodyGrid[r] || [];
        return Array.from({ length: smSteps }, (_, c) => (oldRow[c] !== undefined ? oldRow[c] : false));
      });
      drumGrid = Array.from({ length: 2 }, (_, d) => {
        const oldRow = drumGrid[d] || [];
        return Array.from({ length: smSteps }, (_, c) => (oldRow[c] !== undefined ? oldRow[c] : false));
      });

      renderSongMakerGridUI();
    };

    document.getElementById('sm-bars-input')?.addEventListener('change', updateSongMakerDimensions);
    document.getElementById('sm-scale-mode')?.addEventListener('change', updateSongMakerDimensions);
    document.getElementById('sm-octave')?.addEventListener('change', updateSongMakerDimensions);

    // ★ 動画尺合わせボタン
    document.getElementById('btn-sm-fit-video')?.addEventListener('click', () => {
      const bpm = parseInt(document.getElementById('sm-bpm')?.value) || 120;
      const secondsPerBar = (60 / bpm) * 4;
      const targetDuration = Math.max(2, this.state.duration || 10);
      const neededBars = Math.max(1, Math.ceil(targetDuration / secondsPerBar));

      const inputEl = document.getElementById('sm-bars-input');
      if (inputEl) inputEl.value = neededBars;
      updateSongMakerDimensions();
    });

    // クリアボタン
    document.getElementById('btn-sm-clear')?.addEventListener('click', () => {
      stopSmPlayback();
      melodyGrid = Array.from({ length: melodyRows }, () => Array(smSteps).fill(false));
      drumGrid = Array.from({ length: 2 }, () => Array(smSteps).fill(false));
      renderSongMakerGridUI();
    });

    // ★ 作った曲をタイムラインに追加 ＆ 既存曲の上書き更新
    let editingSongMakerClip = null; // 現在再編集中のクリップ

    this.openSongMakerEditor = (clip = null) => {
      editingSongMakerClip = clip;
      stopSmPlayback();
      const addBtn = document.getElementById('btn-sm-add-timeline');

      if (clip && clip.songMakerData) {
        // 既存クリップのデータを復元
        const data = clip.songMakerData;
        melodyGrid = JSON.parse(JSON.stringify(data.melodyGrid));
        drumGrid = JSON.parse(JSON.stringify(data.drumGrid));
        smBars = data.bars || 4;
        smSteps = smBars * 16;

        const smFieldMap = {
          'sm-bpm': data.bpm || 120,
          'val-sm-bpm': data.bpm || 120,
          'sm-instrument': data.instrument || 'marimba',
          'sm-drum-kit': data.drumKit || 'electronic',
          'sm-bars-input': smBars
        };
        Object.entries(smFieldMap).forEach(([id, val]) => {
          const el = document.getElementById(id);
          if (el) el.tagName === 'SPAN' ? el.innerText = val : el.value = val;
        });

        if (addBtn) addBtn.innerText = '編集した曲をタイムラインに更新';
      } else {
        // 新規作成時：入力欄の現在値に合わせてステップ数を確定
        smBars = parseInt(document.getElementById('sm-bars-input')?.value) || 4;
        smSteps = smBars * 16;

        // グリッド配列のサイズを現在の小節数に合わせる
        melodyGrid = Array.from({ length: melodyRows }, (_, r) => {
          const oldRow = melodyGrid[r] || [];
          return Array.from({ length: smSteps }, (_, c) => oldRow[c] !== undefined ? oldRow[c] : false);
        });
        drumGrid = Array.from({ length: 2 }, (_, d) => {
          const oldRow = drumGrid[d] || [];
          return Array.from({ length: smSteps }, (_, c) => oldRow[c] !== undefined ? oldRow[c] : false);
        });

        if (addBtn) addBtn.innerText = '作った曲をタイムラインにBGMとして追加';
      }

      renderSongMakerGridUI();
      this.toggleSubPanel('panel-audio-gen');
    };

    document.getElementById('btn-sm-add-timeline')?.addEventListener('click', async () => {
      stopSmPlayback();
      this.showLoading("長尺BGMを高音質レンダリング中...");

      await new Promise(r => setTimeout(r, 50)); // UI更新用待機

      try {
        const bpm = parseInt(document.getElementById('sm-bpm')?.value) || 120;
        const inst = document.getElementById('sm-instrument')?.value || 'marimba';
        const drumKit = document.getElementById('sm-drum-kit')?.value || 'electronic';

        // 打ち込んだフレーズを目標小節数まで自動ループ拡張（AudioSynthEngine 委譲）
        const targetSteps = smBars * 16;
        const expandedMelody = this.synthEngine.expandPatternGrid(melodyGrid, targetSteps, melodyRows);
        const expandedDrum = this.synthEngine.expandPatternGrid(drumGrid, targetSteps, 2);

        const audioBuffer = this.synthEngine.renderSongMakerBuffer(expandedMelody, expandedDrum, currentScaleFreqs, bpm, inst, drumKit);
        const wavBlob = this.synthEngine.audioBufferToWavBlob(audioBuffer);
        const file = new File([wavBlob], `SongMaker_${smBars}Bars_${Date.now()}.wav`, { type: 'audio/wav' });

        const smDataToSave = {
          melodyGrid: JSON.parse(JSON.stringify(melodyGrid)),
          drumGrid: JSON.parse(JSON.stringify(drumGrid)),
          bpm: bpm,
          instrument: inst,
          drumKit: drumKit,
          bars: smBars
        };

        if (editingSongMakerClip) {
          this.saveState();
          const audioUrl = URL.createObjectURL(file);
          const audio = new Audio(audioUrl);
          audio.preload = 'metadata';

          editingSongMakerClip.element = audio;
          editingSongMakerClip.duration = audioBuffer.duration;
          editingSongMakerClip.songMakerData = smDataToSave;

          const wf = await this.generateWaveformCanvas(file, this.state.volume.bgm);
          if (wf) editingSongMakerClip.waveform = wf;

          this.recalculateTotalDuration();
          this.setupTimelineUI();
          this.requestRender();
        } else {
          await this.loadAudioFile(file);
          const addedClip = this.state.tracks[this.state.tracks.length - 1];
          if (addedClip) {
            addedClip.songMakerData = smDataToSave;
          }
        }

        editingSongMakerClip = null;
        this.toggleSubPanel('panel-audio-gen');
      } catch (err) {
        alert("レンダリング失敗: " + err.message);
      } finally {
        this.hideLoading();
      }
    });

    // ★ テロップスタイルプリセットのワンタップ適用
    const btnApplyStyle = document.getElementById('btn-apply-text-style');
    const selectStyle = document.getElementById('text-style-preset');

    if (btnApplyStyle && selectStyle) {
      btnApplyStyle.addEventListener('click', () => {
        const item = this.selectedItem;
        if (!item || item.type !== 'text') return;

        const preset = selectStyle.value;
        this.saveState();

        if (preset === 'youtube_red') {
          item.color = '#ffffff';
          item.strokeEnabled = true;
          item.strokeColor = '#000000';
          item.strokeWidth = 6;
          item.stroke2Enabled = true;
          item.stroke2Color = '#ff2d55';
          item.stroke2Width = 14;
          item.gradientEnabled = false;
          item.glowEnabled = false;
        } else if (preset === 'youtube_gold') {
          item.color = '#ffffff';
          item.strokeEnabled = true;
          item.strokeColor = '#000000';
          item.strokeWidth = 6;
          item.stroke2Enabled = true;
          item.stroke2Color = '#ffb703';
          item.stroke2Width = 14;
          item.gradientEnabled = true;
          item.gradientColor1 = '#ffffff';
          item.gradientColor2 = '#ffcc00';
          item.glowEnabled = false;
        } else if (preset === 'neon_cyber') {
          item.color = '#ffffff';
          item.strokeEnabled = true;
          item.strokeColor = '#09090b';
          item.strokeWidth = 4;
          item.stroke2Enabled = false;
          item.gradientEnabled = false;
          item.glowEnabled = true;
          item.glowColor = '#00f0ff';
          item.glowBlur = 20;
        } else if (preset === 'retro_game') {
          item.color = '#ffff00';
          item.strokeEnabled = true;
          item.strokeColor = '#000000';
          item.strokeWidth = 8;
          item.stroke2Enabled = false;
          item.gradientEnabled = false;
          item.glowEnabled = false;
          item.fontFamily = 'DotGothic16';
        } else if (preset === 'cinematic_white') {
          item.color = '#ffffff';
          item.strokeEnabled = false;
          item.stroke2Enabled = false;
          item.gradientEnabled = false;
          item.glowEnabled = false;
          item.fontFamily = 'Shippori Mincho';
        } else if (preset === 'warning_danger') {
          item.color = '#000000';
          item.strokeEnabled = true;
          item.strokeColor = '#ffcc00';
          item.strokeWidth = 6;
          item.stroke2Enabled = true;
          item.stroke2Color = '#ff0000';
          item.stroke2Width = 12;
          item.gradientEnabled = true;
          item.gradientColor1 = '#ffff00';
          item.gradientColor2 = '#ff9500';
          item.glowEnabled = false;
        }

        // キャッシュを破棄してUIと描画を再同期
        item._cachedBitmapKey = null;
        this.initQuillEditor();
        this.requestRender();
      });
    }

    // ★ 縁取り・二重フチ・グラデーション・光彩のリアルタイム反映イベント
    const textStyleInputIds = [
      'text-stroke-enabled', 'text-stroke-color', 'text-stroke-width',
      'text-stroke2-enabled', 'text-stroke2-color', 'text-stroke2-width',
      'text-grad-enabled', 'text-grad-color1', 'text-grad-color2',
      'text-glow-enabled', 'text-glow-color', 'text-glow-blur'
    ];

    textStyleInputIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => {
          const item = this.selectedItem;
          if (!item || item.type !== 'text') return;

          item.strokeEnabled = document.getElementById('text-stroke-enabled')?.checked ?? true;
          item.strokeColor = document.getElementById('text-stroke-color')?.value || '#000000';
          item.strokeWidth = parseFloat(document.getElementById('text-stroke-width')?.value || 6);

          item.stroke2Enabled = !!document.getElementById('text-stroke2-enabled')?.checked;
          item.stroke2Color = document.getElementById('text-stroke2-color')?.value || '#ff0000';
          item.stroke2Width = parseFloat(document.getElementById('text-stroke2-width')?.value || 14);

          item.gradientEnabled = !!document.getElementById('text-grad-enabled')?.checked;
          item.gradientColor1 = document.getElementById('text-grad-color1')?.value || '#ffffff';
          item.gradientColor2 = document.getElementById('text-grad-color2')?.value || '#ffcc00';

          item.glowEnabled = !!document.getElementById('text-glow-enabled')?.checked;
          item.glowColor = document.getElementById('text-glow-color')?.value || '#00f0ff';
          item.glowBlur = parseFloat(document.getElementById('text-glow-blur')?.value || 15);

          // 数値バッジの更新
          const valW1 = document.getElementById('val-text-stroke-width');
          const valW2 = document.getElementById('val-text-stroke2-width');
          const valGlow = document.getElementById('val-text-glow-blur');
          if (valW1) valW1.innerText = `${item.strokeWidth}px`;
          if (valW2) valW2.innerText = `${item.stroke2Width}px`;
          if (valGlow) valGlow.innerText = `${item.glowBlur}px`;

          this.requestRender();
        });
        el.addEventListener('change', () => this.saveState());
      }
    });

    // ★ 図形内コンテンツモード切り替えUI表示制御
    const shapeContentMode = document.getElementById('shape-content-mode');
    const shapeTextGroup = document.getElementById('shape-text-group');
    const shapeMediaGroup = document.getElementById('shape-media-group');

    const updateShapeContentUI = (mode) => {
      if (shapeTextGroup) shapeTextGroup.classList.toggle('hidden', mode !== 'text' && mode !== 'cutout');
      if (shapeMediaGroup) shapeMediaGroup.classList.toggle('hidden', mode !== 'image' && mode !== 'video');
    };

    if (shapeContentMode) {
      shapeContentMode.addEventListener('change', (e) => {
        const mode = e.target.value;
        updateShapeContentUI(mode);
        const item = this.selectedItem;
        if (item && (item.type === 'shape' || item.type === 'rect' || item.type === 'circle')) {
          item.contentMode = mode;
          this.requestRender();
        }
      });
    }

    // 図形グラデーション設定UIイベント
    const shapeFillType = document.getElementById('shape-fill-type');
    const shapeGradGroup = document.getElementById('shape-gradient-group');
    const shapeSingleRow = document.getElementById('shape-color-single-row');

    if (shapeFillType) {
      shapeFillType.addEventListener('change', (e) => {
        const isGrad = e.target.value !== 'solid';
        if (shapeGradGroup) shapeGradGroup.classList.toggle('hidden', !isGrad);
        if (shapeSingleRow) shapeSingleRow.classList.toggle('hidden', isGrad);
        const item = this.selectedItem;
        if (item && (item.type === 'shape' || item.type === 'rect' || item.type === 'circle')) {
          item.gradientType = e.target.value;
          this.requestRender();
        }
      });
    }

    ['shape-grad-color1', 'shape-grad-color2', 'shape-grad-angle'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => {
          const item = this.selectedItem;
          if (!item) return;
          item.gradientColor1 = document.getElementById('shape-grad-color1').value;
          item.gradientColor2 = document.getElementById('shape-grad-color2').value;
          item.gradientAngle = parseFloat(document.getElementById('shape-grad-angle').value);
          const angleVal = document.getElementById('val-shape-grad-angle');
          if (angleVal) angleVal.innerText = `${item.gradientAngle}°`;
          this.requestRender();
        });
        el.addEventListener('change', () => this.saveState());
      }
    });

    // 3Dグラデーションチェックボックスイベント
    document.getElementById('3d-gradient-enabled')?.addEventListener('change', () => {
      this.update3DMaterialAndAnim();
    });
    ['3d-grad-color1', '3d-grad-color2'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => this.update3DMaterialAndAnim());
        el.addEventListener('change', () => this.saveState());
      }
    });

    // ★ 図形設定のリアルタイム即時反映（色・サイズ・形状・塗りタイプすべて）
    ['shape-color', 'shape-size', 'shape-type', 'shape-fill-type'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        const updateShape = () => {
          const item = this.selectedItem;
          if (!item || (item.type !== 'shape' && item.type !== 'rect' && item.type !== 'circle')) return;

          item.type = document.getElementById('shape-type').value;
          item.color = document.getElementById('shape-color').value;
          item.size = parseFloat(document.getElementById('shape-size').value);
          item.width = item.size;
          item.height = item.size;

          const sizeVal = document.getElementById('val-shape-size');
          if (sizeVal) sizeVal.innerText = `${item.size}px`;

          this.setupTimelineUI();
          this.requestRender();
        };

        el.addEventListener('input', updateShape);
        el.addEventListener('change', () => {
          updateShape();
          this.saveState();
        });
      }
    });

    // 図形パネル同期ヘルパー（全形状同期対応版）
    this.syncAndToggleShapePanel = () => {
      const item = this.selectedItem;
      const addBtn = document.getElementById('add-shape-btn');
      const isShapeClip = item && (
        item.type === 'shape' || item.type === 'rect' || item.type === 'circle' ||
        item.type === 'rounded-rect' || item.type === 'triangle' || item.type === 'star' ||
        item.type === 'heart' || item.type === 'diamond' || item.type === 'hexagon' ||
        item.type === 'arrow' || item.type === 'speech-bubble'
      );

      if (isShapeClip) {
        const gradType = item.gradientType || 'solid';
        const size = item.size || 250;
        const angle = item.gradientAngle || 45;

        const shapeSelect = document.getElementById('shape-type');
        if (shapeSelect) shapeSelect.value = item.type || 'rect';
        document.getElementById('shape-color').value = item.color || '#00f0ff';
        document.getElementById('shape-size').value = size;
        document.getElementById('val-shape-size').innerText = `${size}px`;
        document.getElementById('shape-fill-type').value = gradType;
        document.getElementById('shape-gradient-group')?.classList.toggle('hidden', gradType === 'solid');
        document.getElementById('shape-color-single-row')?.classList.toggle('hidden', gradType !== 'solid');
        document.getElementById('shape-grad-color1').value = item.gradientColor1 || '#00f0ff';
        document.getElementById('shape-grad-color2').value = item.gradientColor2 || '#ff007f';
        document.getElementById('shape-grad-angle').value = angle;
        document.getElementById('val-shape-grad-angle').innerText = `${angle}°`;

        if (addBtn) addBtn.innerText = '図形設定を更新';
      } else if (addBtn) {
        addBtn.innerText = '図形をタイムラインに追加';
      }
      this.toggleSubPanel('panel-shape');
    };

    // 図形追加 / 上書き更新ボタン
    const addShapeBtn = document.getElementById('add-shape-btn');
    if (addShapeBtn) {
      addShapeBtn.addEventListener('click', () => {
        this.saveState();
        const shapeType = document.getElementById('shape-type').value;
        const color = document.getElementById('shape-color').value;
        const size = parseFloat(document.getElementById('shape-size').value) || 250;

        const gradType = document.getElementById('shape-fill-type')?.value || 'solid';
        const gradCol1 = document.getElementById('shape-grad-color1')?.value || '#00f0ff';
        const gradCol2 = document.getElementById('shape-grad-color2')?.value || '#ff007f';
        const gradAng = parseFloat(document.getElementById('shape-grad-angle')?.value) || 45;

        const currentItem = this.selectedItem;
        const shapeProps = {
          type: shapeType, color, size, width: size, height: size,
          gradientType: gradType, gradientColor1: gradCol1, gradientColor2: gradCol2, gradientAngle: gradAng
        };

        if (currentItem && (currentItem.type === 'shape' || currentItem.type === 'rect' || currentItem.type === 'circle')) {
          Object.assign(currentItem, shapeProps);
        } else {
          this.addTrackClip({ ...shapeProps, duration: 3, physics: { enabled: false, bounciness: 0.4, isStatic: false } });
        }

        document.getElementById('panel-shape').classList.add('hidden');
        this.notifyUpdate();
      });
    }
    // ★ 選択中3Dオブジェクトの形状即時上書き差し替え（立体 ➔ パーティクル完全対応）
    document.getElementById('3d-shape-type')?.addEventListener('change', (e) => {
      if (!this.selectedItem || this.selectedItem.type !== '3d' || !this.selectedItem.model) return;
      const shapeType = e.target.value;
      const currentItem = this.selectedItem;

      this.saveState();

      // 既存モデルを安全に破棄
      if (this.threeEngine) {
        this.threeEngine.disposeModel(currentItem.model);
      }

      // 新しい形状（またはパーティクル）を生成
      let newMesh = null;
      if (shapeType.startsWith('particles-')) {
        const pType = shapeType.replace('particles-', '');
        newMesh = this.threeEngine ? this.threeEngine.createParticleSystem(pType, 250) : null;
      } else {
        newMesh = this.threeEngine ? this.threeEngine.createPrimitive(shapeType, currentItem.materialProps?.color || '#00f0ff') : null;
      }

      currentItem.model = newMesh;
      currentItem.name = `3D ${shapeType}`;

      // 既存のマテリアル・アニメーション設定を即座に適用
      if (newMesh && this.threeEngine && currentItem.materialProps) {
        this.threeEngine.applyMaterialProps(newMesh, currentItem.materialProps);
      }

      // パーティクル切り替え時にUIコントロールの表示/非表示を再同期
      this.syncAndToggle3DPanel();
      // 再度パネルを開いたまま維持
      document.getElementById('panel-3d')?.classList.remove('hidden');

      this.setupTimelineUI();
      this.requestRender();
    });

    // ★ 新規追加ボタン（新規素材はアニメーション「なし」で独立生成）
    const add3DBtn = document.getElementById('add-3d-btn');
    if (add3DBtn) {
      add3DBtn.addEventListener('click', () => {
        const shapeType = document.getElementById('3d-shape-type')?.value || 'plane';
        const color = document.getElementById('3d-color')?.value || '#00f0ff';

        this.createPrimitive3DShape(shapeType, color);

        const newClip = this.state.tracks[this.state.tracks.length - 1];
        if (newClip && newClip.type === '3d') {
          // ★ 新規作成時は以前の設定に引きずられないようアニメーションを「なし」にリセット
          newClip.animMode = 'none';
          newClip.animSpeed = 1.0;
          newClip.animProps = { inAnim: 'none', mainAnim: 'none', outAnim: 'none' };

          this.selectedItems = [newClip];
          this.update3DMaterialAndAnim();
        }

        document.getElementById('panel-3d')?.classList.add('hidden');
      });
    }
    document.getElementById('aspect-select').addEventListener('change', (e) => {
      this.state.aspectRatio = e.target.value;
      this.updateAspectRatio();
    });

    // カスタム幅・高さの入力イベントを追加
    ['custom-width', 'custom-height'].forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        input.addEventListener('input', () => {
          if (this.state.aspectRatio === 'custom') {
            this.updateAspectRatio();
          }
        });
      }
    });

    const chromaEnabled = document.getElementById('chroma-enabled');
    if (chromaEnabled) {
      chromaEnabled.addEventListener('change', (e) => {
        this.state.chromaKey.enabled = e.target.checked;
        this.requestRender(); // ON/OFF切り替え時に画面を即座に書き換え
      });
    }

    // ★ 透過する色の変更
    const chromaColor = document.getElementById('chroma-color');
    if (chromaColor) {
      chromaColor.addEventListener('input', (e) => {
        const hex = e.target.value;
        this.state.chromaKey.targetColor = {
          r: parseInt(hex.slice(1, 3), 16),
          g: parseInt(hex.slice(3, 5), 16),
          b: parseInt(hex.slice(5, 7), 16)
        };
        this.requestRender();
      });
    }

    // ★ 許容範囲スライダーの変更
    const chromaTolerance = document.getElementById('chroma-tolerance');
    if (chromaTolerance) {
      chromaTolerance.addEventListener('input', (e) => {
        const val = e.target.value;
        this.state.chromaKey.tolerance = parseFloat(val);
        const valEl = document.getElementById('val-chroma-tolerance');
        if (valEl) valEl.innerText = val; // 右側に数値を表示
        this.requestRender();
      });
    }

    // ★ なめらかさスライダーの変更
    const chromaSmoothness = document.getElementById('chroma-smoothness');
    if (chromaSmoothness) {
      chromaSmoothness.addEventListener('input', (e) => {
        const val = e.target.value;
        this.state.chromaKey.smoothness = parseFloat(val);
        const valEl = document.getElementById('val-chroma-smoothness');
        if (valEl) valEl.innerText = val; // 右側に数値を表示
        this.requestRender();
      });
    }

    // 汎用DOM値リセットヘルパー
    const resetFormValues = (fieldMap) => {
      Object.entries(fieldMap).forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!val;
        else if (el.tagName === 'SPAN') el.innerText = String(val);
        else el.value = val;
      });
    };

    // 1. フィルターリセット（スキーマ駆動自動初期化）
    document.getElementById('reset-filter-btn')?.addEventListener('click', () => {
      this.saveState();
      const resetMap = {
        'filter-lut-preset': 'none',
        'filter-lut-intensity': 80,
        'val-filter-lut': '80%'
      };

      VideoEditorEngine.FILTER_SCHEMA.forEach(f => {
        this.state.filters[f.key] = f.default;
        resetMap[`filter-${f.key}`] = f.default;
      });
      this.state.filters.lutPreset = 'none';
      this.state.filters.lutIntensity = 0.8;

      resetFormValues(resetMap);
      this.requestRender();
    });

    // 2. 変形設定リセット
    document.getElementById('reset-trans-btn')?.addEventListener('click', () => {
      if (!this.selectedItem?.transform) return;
      this.saveState();
      this.selectedItem.transform = { scale: 1.0, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 };
      this.selectedItem.physics = { enabled: true, bounciness: 0.4, isStatic: false };

      resetFormValues({
        'trans-scale': 100, 'trans-rotate': 0, 'trans-rotate-x': 0, 'trans-rotate-y': 0,
        'trans-x': 0, 'trans-y': 0, 'phys-collision-enabled': true, 'phys-static-enabled': false,
        'phys-bounce-rate': 40, 'val-phys-bounce': '40%', 'val-trans-scale': '100%',
        'val-trans-rotate': '0度', 'val-trans-rotate-x': '0度', 'val-trans-rotate-y': '0度',
        'val-trans-x': '0px', 'val-trans-y': '0px'
      });
      this.requestRender();
    });

    // ★ 整列・等間隔配置の幾何計算を KeyframeEngine に委譲
    const executeAlignment = (action) => {
      if (!this.selectedItems || this.selectedItems.length === 0 || !window.KeyframeEngine) return;
      this.saveState();

      const mode = document.getElementById('align-anchor-mode')?.value || 'key';
      this.selectedItems.forEach(i => {
        if (!i.transform) i.transform = { scale: 1, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 };
      });

      window.KeyframeEngine.alignClips(
        this.selectedItems,
        action,
        mode,
        this.canvas.width,
        this.canvas.height,
        (item) => this.getClipDimensions(item, true)
      );

      this.requestRender();
      if (navigator.vibrate) navigator.vibrate(15);
    };

    document.getElementById('btn-align-left')?.addEventListener('click', () => executeAlignment('left'));
    document.getElementById('btn-align-hcenter')?.addEventListener('click', () => executeAlignment('hcenter'));
    document.getElementById('btn-align-right')?.addEventListener('click', () => executeAlignment('right'));
    document.getElementById('btn-align-top')?.addEventListener('click', () => executeAlignment('top'));
    document.getElementById('btn-align-vcenter')?.addEventListener('click', () => executeAlignment('vcenter'));
    document.getElementById('btn-align-bottom')?.addEventListener('click', () => executeAlignment('bottom'));
    document.getElementById('btn-distribute-h')?.addEventListener('click', () => executeAlignment('distribute-h'));
    document.getElementById('btn-distribute-v')?.addEventListener('click', () => executeAlignment('distribute-v'));

    // 3. 音量・ピッチ・フェードのリセット
    document.getElementById('reset-audio-btn')?.addEventListener('click', () => {
      this.saveState();
      this.state.volume = { video: 1.0, bgm: 1.0, pitch: 1.0, isMuted: false };
      if (this.selectedItem) {
        this.selectedItem.audioFadeIn = 0;
        this.selectedItem.audioFadeOut = 0;
      }
      resetFormValues({
        'vol-video': 100, 'vol-bgm': 100, 'pitch-rate': 100,
        'val-vol-video': '100%', 'val-vol-bgm': '100%', 'val-pitch-rate': '100%',
        'audio-fade-in': 0, 'audio-fade-out': 0,
        'val-audio-fade-in': '0.0s', 'val-audio-fade-out': '0.0s'
      });
      this.updateVolume();
      this.state.tracks.forEach(t => { if (t.element) t.element.playbackRate = 1.0; });
      this.redrawAllWaveforms();
      this.requestRender();
    });

    // 4. クロマキー設定のリセット
    document.getElementById('reset-chroma-btn')?.addEventListener('click', () => {
      this.saveState();
      this.state.chromaKey = { enabled: false, targetColor: { r: 0, g: 255, b: 0 }, tolerance: 40, smoothness: 10 };
      resetFormValues({
        'chroma-enabled': false, 'chroma-color': '#00ff00',
        'chroma-tolerance': 40, 'chroma-smoothness': 10,
        'val-chroma-tolerance': '40', 'val-chroma-smoothness': '10'
      });
      this.requestRender();
    });

    const tc = this.timelineContainer;

    // 手動スクロール時にタイムルーラーをリアルタイム再描画
    if (tc) {
      tc.addEventListener('scroll', () => {
        this.renderTimeRuler();
      }, { passive: true });
    }

    // タイムライン余白クリック・ドラッグによる直感的シーク
    if (tc) {
      tc.addEventListener('pointerdown', (e) => {
        const isClip = e.target.closest('.timeline-clip');
        const isTrimHandle = e.target.classList.contains('trim-handle');
        const isHeader = e.target.closest('.track-header-cell');

        if (isClip || isTrimHandle || isHeader) return;

        this.deselectAll();
        this.requestRender();

        const rect = tc.getBoundingClientRect();
        const isMarqueeMode = e.shiftKey || this.state.isMultiSelectMode;

        if (isMarqueeMode) {
          // タイムライン矩形範囲選択 (ラバーバンド)
          const marqueeStartX = e.clientX - rect.left + tc.scrollLeft;
          const marqueeStartY = e.clientY - rect.top + tc.scrollTop;

          let marqueeEl = document.createElement('div');
          marqueeEl.className = 'timeline-selection-marquee';
          tc.appendChild(marqueeEl);

          const onMarqueeMove = (moveEvent) => {
            const curX = moveEvent.clientX - rect.left + tc.scrollLeft;
            const curY = moveEvent.clientY - rect.top + tc.scrollTop;

            const left = Math.min(marqueeStartX, curX);
            const top = Math.min(marqueeStartY, curY);
            const width = Math.abs(curX - marqueeStartX);
            const height = Math.abs(curY - marqueeStartY);

            marqueeEl.style.left = `${left}px`;
            marqueeEl.style.top = `${top}px`;
            marqueeEl.style.width = `${width}px`;
            marqueeEl.style.height = `${height}px`;

            // 枠と接触したクリップを一括選択
            const selStartSec = Math.max(0, (left - 156) / this.state.zoom);
            const selEndSec = Math.max(0, (left + width - 156) / this.state.zoom);

            const hitClips = this.state.tracks.filter(clip => {
              const cStart = clip.startTime || 0;
              const cEnd = cStart + (clip.duration || 0);
              return !(cEnd < selStartSec || cStart > selEndSec);
            });

            this.selectedItems = hitClips;
            this.updateContextualToolbar();
            this.setupTimelineUI();
          };

          const onMarqueeUp = () => {
            if (marqueeEl && marqueeEl.parentNode) {
              marqueeEl.parentNode.removeChild(marqueeEl);
            }
            window.removeEventListener('pointermove', onMarqueeMove);
            window.removeEventListener('pointerup', onMarqueeUp);
            window.removeEventListener('pointercancel', onMarqueeUp);
          };

          window.addEventListener('pointermove', onMarqueeMove);
          window.addEventListener('pointerup', onMarqueeUp);
          window.addEventListener('pointercancel', onMarqueeUp);
          return;
        }

        const updateSeekPos = (clientX) => {
          const clickX = clientX - rect.left;
          if (clickX < 140) return;
          const scrollOffset = tc.scrollLeft;
          let targetTime = Math.max(0, (clickX - 156 + scrollOffset) / this.state.zoom);
          if (this.state.isSnapEnabled) {
            targetTime = this.applySnapping(targetTime);
          }
          targetTime = Math.max(0, Math.min(this.state.duration, targetTime));
          this.seekTo(targetTime, true);
        };

        this.pause();
        updateSeekPos(e.clientX);

        if (e.pointerId !== undefined && tc.setPointerCapture) {
          try { tc.setPointerCapture(e.pointerId); } catch (err) {}
        }

        const onSeekMove = (moveEvent) => {
          updateSeekPos(moveEvent.clientX);
        };

        const onSeekUp = (upEvent) => {
          if (upEvent.pointerId !== undefined && tc.releasePointerCapture) {
            try { tc.releasePointerCapture(upEvent.pointerId); } catch (err) {}
          }
          window.removeEventListener('pointermove', onSeekMove);
          window.removeEventListener('pointerup', onSeekUp);
          window.removeEventListener('pointercancel', onSeekUp);
        };

        window.addEventListener('pointermove', onSeekMove);
        window.addEventListener('pointerup', onSeekUp);
        window.addEventListener('pointercancel', onSeekUp);
      });
    }

    // すべての字幕にスタイル一括適用ボタンのイベント登録
    document.getElementById('btn-apply-style-all-captions')?.addEventListener('click', () => {
      const primary = this.selectedItem;
      if (!primary || primary.type !== 'text') {
        alert("スタイルをコピーしたいテキスト素材を1つ選択してください。");
        return;
      }
      this.saveState();

      const { color, fontFamily, fontSize, strokeEnabled, strokeColor, strokeWidth, stroke2Enabled, stroke2Color, stroke2Width, gradientEnabled, gradientColor1, gradientColor2, glowEnabled, glowColor, glowBlur } = primary;

      let appliedCount = 0;
      this.state.tracks.forEach(clip => {
        if (clip.type === 'text') {
          Object.assign(clip, { color, fontFamily, fontSize, strokeEnabled, strokeColor, strokeWidth, stroke2Enabled, stroke2Color, stroke2Width, gradientEnabled, gradientColor1, gradientColor2, glowEnabled, glowColor, glowBlur });
          clip._cachedBitmapKey = null;
          clip._cachedLines = null;
          appliedCount++;
        }
      });

      this.requestRender();
      alert(`プロジェクト内のすべての字幕 (${appliedCount}個) にスタイルを一括適用しました。`);
    });

    // 「書き出し」ボタンを押したら設定モーダルを開いて予測計算を実行
    document.getElementById('export-btn').addEventListener('click', () => {
      this.updateExportEstimates();
      document.getElementById('panel-export').classList.remove('hidden');
    });

    // モーダル内の設定変更時にリアルタイムで予測サイズ/時間を再計算
    ['export-format', 'export-fps', 'export-quality'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', () => this.updateExportEstimates());
    });

    // 「書き出しスタート」ボタンを押して実際のエンコードを実行
    document.getElementById('start-export-btn').addEventListener('click', () => {
      document.getElementById('panel-export').classList.add('hidden');
      this.exportVideo();
    });

    // ★ サムネイル即時保存ボタンのイベント連動（ここに追加！）
    document.getElementById('btn-snap-thumb-png')?.addEventListener('click', () => {
      const filename = document.getElementById('export-filename')?.value.trim() || 'thumbnail';
      window.ExportEngine.constructor.exportThumbnail(this.canvas, 'png', filename);
    });

    document.getElementById('btn-snap-thumb-jpg')?.addEventListener('click', () => {
      const filename = document.getElementById('export-filename')?.value.trim() || 'thumbnail';
      window.ExportEngine.constructor.exportThumbnail(this.canvas, 'jpg', filename);
    });

    // 台本・スクリプト編集ボタン連携
    document.getElementById('btn-apply-script')?.addEventListener('click', () => {
      this.applyScriptToTimeline();
    });

    document.getElementById('btn-copy-script')?.addEventListener('click', () => {
      const textarea = document.getElementById('timeline-script-textarea');
      if (textarea) {
        navigator.clipboard.writeText(textarea.value);
        alert("台本テキストをクリップボードにコピーしました。");
      }
    });

    document.getElementById('btn-load-tutorial')?.addEventListener('click', () => {
      const select = document.getElementById('select-script-tutorial');
      const textarea = document.getElementById('timeline-script-textarea');
      if (select && textarea && window.ScriptDSL.tutorials[select.value]) {
        textarea.value = window.ScriptDSL.tutorials[select.value];
      }
    });
    const clipInInput = document.getElementById('clip-in-time');
    const clipOutInput = document.getElementById('clip-out-time');
    const clipDurInput = document.getElementById('clip-dur-time');
    const clipQuickText = document.getElementById('clip-quick-text');

    const updateSelectedClipTiming = (e) => {
      const item = this.selectedItem;
      if (!item) return;

      this.saveState();

      const roundSec = (val) => Math.round(val * 100) / 100;

      const newIn = roundSec(parseFloat(clipInInput.value) || 0);
      const newOut = roundSec(parseFloat(clipOutInput.value) || 0);
      const newDur = Math.max(0.1, roundSec(parseFloat(clipDurInput.value) || 0.1));

      // IN / OUT / DUR どの入力欄が変更されたかによって計算を変更
      if (e.target === clipInInput || e.target === clipDurInput) {
        item.startTime = Math.max(0, newIn);
        item.duration = newDur;
      } else if (e.target === clipOutInput) {
        const curStart = item.startTime || 0;
        item.duration = Math.max(0.1, roundSec(newOut - curStart));
      }

      this.recalculateTotalDuration();
      this.setupTimelineUI();
      this.updateSelectedClipTimeUI();
      this.requestRender();
    };

    if (clipInInput) clipInInput.addEventListener('change', updateSelectedClipTiming);
    if (clipOutInput) clipOutInput.addEventListener('change', updateSelectedClipTiming);
    if (clipDurInput) clipDurInput.addEventListener('change', updateSelectedClipTiming);

    document.getElementById('btn-clip-toggle-hide')?.addEventListener('click', () => {
      this.toggleSelectedItemVisibility();
    });

    document.getElementById('btn-clip-toggle-lock')?.addEventListener('click', () => {
      const item = this.selectedItem;
      if (!item) return;
      this.saveState();
      item.locked = !item.locked;
      this.updateSelectedClipTimeUI();
      this.setupTimelineUI();
    });

    document.getElementById('btn-clip-toggle-mute')?.addEventListener('click', () => {
      const item = this.selectedItem;
      if (!item) return;
      this.saveState();
      const currentMuted = item.customVolume === 0 || !!item.isAudioMuted;
      item.isAudioMuted = !currentMuted;
      item.customVolume = item.isAudioMuted ? 0 : 1.0;
      this.updateVolume();
      this.updateSelectedClipTimeUI();
      this.setupTimelineUI();
    });

    // テキスト直接編集時のリアルタイム同期 (描画キャッシュ即時クリア)
    if (clipQuickText) {
      clipQuickText.addEventListener('input', (e) => {
        const item = this.selectedItem;
        if (!item) return;

        const val = e.target.value;
        if (item.text !== undefined) {
          item.text = val;

          // ★ キーフレーム設定済みテキストの場合、現在時刻のアクティブキーフレームも同期更新
          if (Array.isArray(item.textKeyframes) && item.textKeyframes.length > 0) {
            const relSec = Math.max(0, this.state.currentTime - item.startTime);
            let activeKf = item.textKeyframes[0];
            for (let i = 0; i < item.textKeyframes.length; i++) {
              if (relSec >= item.textKeyframes[i].time) {
                activeKf = item.textKeyframes[i];
              }
            }
            if (activeKf) {
              activeKf.text = val;
            }
          }

          // ★ テキストキャッシュを即座に破棄してプレビュー画面へ確実に反映
          item._cachedLines = null;
          item._lastTextCacheKey = null;
          item._cachedBitmapKey = null;
        } else {
          item.name = val;
        }

        if (this.quill && item.type === 'text') {
          // ★ Quill 自身にフォーカスがない場合のみ同期してキャレット破壊を防止
          const quillEditorEl = document.querySelector('#quill-editor .ql-editor');
          const isQuillFocused = quillEditorEl && document.activeElement === quillEditorEl;

          if (!isQuillFocused && this.quill.getText().trim() !== val.trim()) {
            const currentFormat = this.quill.getFormat();
            this.quill.setText(val, 'api');
            if (val.length > 0) {
              Object.keys(currentFormat).forEach(fmt => {
                this.quill.formatText(0, val.length, fmt, currentFormat[fmt], 'api');
              });
            }
          }
        }
        this.setupTimelineUI();
        this.requestRender();
      });

      // ★ 入力確定時にUndo履歴を記録
      clipQuickText.addEventListener('change', () => {
        this.saveState();
      });
    }
  }
  // ★ AI音源解析によるビートマーカー自動打刻（音ハメ動画機能）
  async detectAndApplyBeats() {
    const clip = this.selectedItem || this.state.tracks.find(t => t.type === 'audio' || t.type === 'video');
    if (!clip || !clip.element?.src) {
      alert("ビートを検出したい音声または動画素材を選択してください。");
      return;
    }

    this.showLoading("楽曲のリズム・キック音を解析中...");

    try {
      const response = await fetch(clip.element.src);
      const arrayBuf = await response.arrayBuffer();
      const audioCtx = this.getAudioContext();
      const decoded = await audioCtx.decodeAudioData(arrayBuf);

      // VideoProcessor で低音アタック解析
      const beats = window.VideoProcessor.detectBeats(decoded, 1.35, 0.22);

      if (!beats || beats.length === 0) {
        alert("明確なリズム・ビートを検出できませんでした。");
        return;
      }

      this.saveState();

      const clipStart = clip.startTime || 0;
      if (!this.state.markers) this.state.markers = [];

      // 既存の自動ビートマーカーを一旦クリーンアップ（重複防止）
      this.state.markers = this.state.markers.filter(m => !m.isBeat);

      // 検出したビートをタイムラインマーカーとして一括登録
      beats.forEach((bTime, idx) => {
        const globalTime = parseFloat((clipStart + bTime).toFixed(3));
        if (globalTime <= this.state.duration) {
          this.state.markers.push({
            id: `beat-${Date.now()}-${idx}`,
            time: globalTime,
            label: `Beat ${idx + 1}`,
            isBeat: true
          });
        }
      });

      this.state.markers.sort((a, b) => a.time - b.time);

      this.renderTimeRuler();
      this.setupTimelineUI();
      if (navigator.vibrate) navigator.vibrate([20, 50, 20]);

      alert(`AIビート検出完了！\n${beats.length} 箇所のビートに黄色マーカーを打刻しました。\n（素材をドラッグすると自動でリズムにスナップ吸着します）`);
    } catch (err) {
      alert("ビート解析エラー: " + err.message);
    } finally {
      this.hideLoading();
    }
  }
  async generateAutoSubtitles() {
    const mainClip = this.selectedItems.find(i => i.type === 'video' || i.type === 'audio') ||
                     this.state.tracks.find(t => t.type === 'video' || t.type === 'audio');

    if (!mainClip || !mainClip.element) {
      alert("字幕を起こしたい動画または音声素材を選択してください。");
      return;
    }

    this.showLoading("Whisper AI モデル準備中...");

    try {
      const validChunks = await window.AutoSubtitlesEngine.transcribeAudioClip(
        mainClip,
        this.getAudioContext(),
        (statusText) => this.showLoading(statusText)
      );

      this.saveState();
      const isKeyframeMode = confirm(
        "[字幕の配置形式を選択]\n\n" +
        "- [OK] : 1本の長いクリップにキーフレームで統合 (解説枠・固定字幕向け)\n" +
        "- [キャンセル] : 発話ごとに個別の文字クリップに分割配置 (通常のテロップ向け)"
      );

      const baseOffset = mainClip.startTime || 0;

      if (isKeyframeMode) {
        const mergedClip = window.AutoSubtitlesEngine.buildMergedCaptionClip(validChunks, baseOffset, mainClip.duration);
        this.state.tracks.push(mergedClip);
        this.selectedItems = [mergedClip];
        this.toggleSubPanel('panel-caption-editor');
        this.initQuillEditor();
      } else {
        const newClips = window.AutoSubtitlesEngine.buildSegmentedCaptionClips(
          validChunks,
          baseOffset,
          (s, d) => this.getAvailableTrackIndex(s, d)
        );
        this.state.tracks.push(...newClips);
        this.selectedItems = newClips;
      }

      this.notifyUpdate();
      alert(`字幕の自動生成が完了しました (${validChunks.length}件)`);
    } catch (err) {
      alert("字幕生成エラー: " + err.message);
    } finally {
      this.hideLoading();
    }
  }
  applySnapping(targetTime, currentClipId = null, clipDuration = 0) {
    if (!window.KeyframeEngine) return targetTime;

    const { time, snappedPoint } = window.KeyframeEngine.calculateSnapTime(
      targetTime,
      this.state.tracks,
      this.state.currentTime,
      this.state.markers,
      currentClipId,
      clipDuration,
      this.state.zoom
    );

    if (snappedPoint !== null && navigator.vibrate) {
      navigator.vibrate(8);
    }

    return time;
  }

  // ★ 物理衝突判定を KeyframeEngine に委譲（明示的ON時のみ確実に動作）
  checkClipsCollision() {
    const activeDrag = this.dragState.selectedClip;
    // 操作中の素材自身が物理有効（physics.enabled === true）でなければスキップ
    if (!this.dragState.isDraggingText || !activeDrag || !activeDrag.physics?.enabled || !window.KeyframeEngine) return;

    const curClips = this.state.tracks.filter(t => 
      t !== activeDrag &&
      t.transform && 
      !t.hidden &&
      t.physics?.enabled === true && // 相手側も物理がONの素材のみ対象
      this.state.currentTime >= t.startTime && 
      this.state.currentTime <= t.startTime + t.duration
    );

    if (curClips.length > 0) {
      window.KeyframeEngine.resolveCollision(activeDrag, curClips, (item) => this.getClipDimensions(item, true));
    }
  }

  setZoom(newZoom) {
    const clampedZoom = Math.max(0.1, Math.min(newZoom, 500));
    if (Math.abs(this.state.zoom - clampedZoom) < 0.001) return;
    this.state.zoom = clampedZoom;

    const zoomSlider = document.getElementById('zoom-slider');
    if (zoomSlider && parseFloat(zoomSlider.value) !== clampedZoom) {
      zoomSlider.value = clampedZoom;
    }

    const totalWidth = 156 + (this.state.duration * this.state.zoom);
    this.timelineTracks.style.width = `${totalWidth}px`;

    this.state.tracks.forEach(clip => {
      const el = this._clipDomMap.get(clip.id);
      if (el) {
        el.style.transform = `translate3d(${156 + (clip.startTime * this.state.zoom)}px, 0, 0)`;
        el.style.width = `${clip.duration * this.state.zoom}px`;
      }
    });

    this.updateTimelinePadding();
    this.updateTimelineUIOnly();
  }
  renderTimeRuler() {
    const ruler = document.getElementById('time-ruler');
    if (!ruler) return;

    const viewWidth = this.timelineContainer ? this.timelineContainer.clientWidth : window.innerWidth;
    const rulerHeight = 26;
    const scrollOffset = this.timelineContainer ? this.timelineContainer.scrollLeft : 0;
    const zoom = Math.max(0.1, this.state.zoom || 60);

    if (ruler.width !== viewWidth || ruler.height !== rulerHeight) {
      ruler.width = viewWidth;
      ruler.height = rulerHeight;
    }

    const ctx = ruler.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // 1. ルーラー全体の背景
    ctx.fillStyle = '#141417';
    ctx.fillRect(0, 0, viewWidth, rulerHeight);

    // 下部境界線
    ctx.strokeStyle = '#27272a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerHeight - 0.5);
    ctx.lineTo(viewWidth, rulerHeight - 0.5);
    ctx.stroke();

    // 2. 目盛り刻み幅の決定
    let majorStep = 5;
    let minorStep = 1;

    if (zoom < 0.2) { majorStep = 600; minorStep = 120; }
    else if (zoom < 0.8) { majorStep = 300; minorStep = 60; }
    else if (zoom < 2.5) { majorStep = 60; minorStep = 10; }
    else if (zoom < 8.0) { majorStep = 30; minorStep = 5; }
    else if (zoom < 25.0) { majorStep = 10; minorStep = 2; }
    else if (zoom < 60.0) { majorStep = 5; minorStep = 1; }
    else if (zoom < 150.0) { majorStep = 2; minorStep = 0.5; }
    else { majorStep = 1; minorStep = 0.2; }

    const maxDur = Math.max(0.1, this.state.duration || 10);
    const leftSec = Math.max(0, (scrollOffset - 156) / zoom);
    const rightSec = Math.min(maxDur, (scrollOffset + viewWidth - 156) / zoom);

    const startMinor = Math.floor(leftSec / minorStep) * minorStep;
    const endMinor = Math.ceil(rightSec / minorStep) * minorStep;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    // 3. 小目盛り線 (有効尺の範囲内のみ描画)
    ctx.strokeStyle = '#3f3f46';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let tickCount = 0;
    const isMajorMultiple = (sec) => Math.abs(Math.round(sec / majorStep) * majorStep - sec) < 0.001;

    for (let sec = startMinor; sec <= endMinor && tickCount < 300; sec += minorStep) {
      tickCount++;
      if (sec < 0 || sec > maxDur) continue;
      const x = Math.round(156 + (sec * zoom) - scrollOffset);
      if (x < 140 || x > viewWidth) continue;

      if (!isMajorMultiple(sec)) {
        ctx.moveTo(x + 0.5, rulerHeight - 5);
        ctx.lineTo(x + 0.5, rulerHeight - 1);
      }
    }
    ctx.stroke();

    // 4. 大目盛り線 ＆ 文字 (有効尺の範囲内のみ描画)
    const startMajor = Math.floor(leftSec / majorStep) * majorStep;
    const endMajor = Math.ceil(rightSec / majorStep) * majorStep;

    ctx.strokeStyle = '#71717a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const textLabelsToDraw = [];

    for (let sec = startMajor; sec <= endMajor; sec += majorStep) {
      if (sec < 0 || sec > maxDur) continue;
      const x = Math.round(156 + (sec * zoom) - scrollOffset);
      if (x < 140 || x > viewWidth + 40) continue;

      ctx.moveTo(x + 0.5, rulerHeight - 9);
      ctx.lineTo(x + 0.5, rulerHeight - 1);

      const hours = Math.floor(sec / 3600);
      const mins = Math.floor((sec % 3600) / 60);
      const secs = Math.floor(sec % 60);
      const frac = Math.round((sec % 1) * 10);

      let labelText = '';
      if (hours > 0) {
        labelText = `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      } else if (majorStep < 1) {
        labelText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${frac}`;
      } else {
        labelText = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      }

      textLabelsToDraw.push({ text: labelText, x: x });
    }
    ctx.stroke();

    ctx.fillStyle = '#a1a1aa';
    ctx.font = 'bold 9px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';
    for (let i = 0; i < textLabelsToDraw.length; i++) {
      ctx.fillText(textLabelsToDraw[i].text, textLabelsToDraw[i].x, 4);
    }

    // 5. 左端 140px の固定「トラック」ヘッダー描画（目盛りの上にかぶせて固定）
    ctx.fillStyle = '#18181b';
    ctx.fillRect(0, 0, 140, rulerHeight);
    ctx.strokeStyle = '#27272a';
    ctx.beginPath();
    ctx.moveTo(139.5, 0);
    ctx.lineTo(139.5, rulerHeight);
    ctx.moveTo(0, rulerHeight - 0.5);
    ctx.lineTo(140, rulerHeight - 0.5);
    ctx.stroke();

    ctx.fillStyle = '#71717a';
    ctx.textAlign = 'left';
    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, Monaco, monospace';
    ctx.fillText('トラック', 12, 6);

    // 6. マーカーピンの描画
    const allMarkers = [...(this.state.markers || [])];
    if (this.selectedItem && Array.isArray(this.selectedItem.markers)) {
      this.selectedItem.markers.forEach(m => allMarkers.push({ ...m, time: this.selectedItem.startTime + m.time, isClipMarker: true }));
    }

    allMarkers.forEach(m => {
      const x = Math.round(156 + (m.time * zoom) - scrollOffset);
      if (x >= 140 && x <= viewWidth) {
        if (m.isBeat) {
          ctx.fillStyle = '#ff9500';
          ctx.beginPath();
          ctx.moveTo(x, 2);
          ctx.lineTo(x + 3.5, 7);
          ctx.lineTo(x, 12);
          ctx.lineTo(x - 3.5, 7);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = m.isClipMarker ? '#00f0ff' : '#ffcc00';
          ctx.beginPath();
          ctx.moveTo(x - 4, 1);
          ctx.lineTo(x + 4, 1);
          ctx.lineTo(x + 4, 7);
          ctx.lineTo(x, 12);
          ctx.lineTo(x - 4, 7);
          ctx.closePath();
          ctx.fill();
        }
      }
    });
  }

  initDragAndDrop() {
    const dropZone = document.getElementById('drop-zone');
    const dragOverlay = document.getElementById('drag-overlay');
    const timelineZone = document.getElementById('timeline-container');

    // ウィンドウ全体のファイル誤オープン（別タブ遷移）を完全ブロック
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    }, false);

    window.addEventListener('drop', (e) => {
      e.preventDefault();
    }, false);

    // 全ファイル形式対応の統括ファイルプロセッサ
    const handleFiles = async (files, dropStartTime = null, dropTrackIdx = null) => {
      if (!files || files.length === 0) return;

      let curStartTime = dropStartTime !== null ? dropStartTime : this.state.currentTime;

      for (const file of Array.from(files)) {
        const lowerName = file.name.toLowerCase();

        // 1. プロジェクトファイル (.json)
        if (lowerName.endsWith('.json')) {
          if (window.ProjectManager) {
            await window.ProjectManager.loadProject(this, file);
          }
          return;
        }

        // 2. 映画風 3D-LUT ファイル (.cube)
        if (lowerName.endsWith('.cube') && window.VideoProcessor) {
          try {
            const text = await file.text();
            this._customLutData = window.VideoProcessor.parseCubeLUT(text);
            this.state.filters.lutPreset = 'custom_cube';
            const lutSelect = document.getElementById('filter-lut-preset');
            if (lutSelect) lutSelect.value = 'custom_cube';
            this.requestRender();
            alert(`LUTファイル「${file.name}」を適用しました。`);
          } catch (err) {
            alert("LUTファイルの解析に失敗しました: " + err.message);
          }
          return;
        }

        // 3. 動画ファイル
        if (file.type.startsWith('video/') || lowerName.endsWith('.mp4') || lowerName.endsWith('.mov') || lowerName.endsWith('.webm') || lowerName.endsWith('.mkv') || lowerName.endsWith('.avi')) {
          const added = await this.loadVideoFile(file, curStartTime);
          if (added) {
            if (dropTrackIdx !== null) added.trackIndex = dropTrackIdx;
            curStartTime += added.duration;
          }
        }
        // 4. 画像ファイル
        else if (file.type.startsWith('image/')) {
          const added = await this.loadImageFile(file);
          if (added) {
            if (dropTrackIdx !== null) added.trackIndex = dropTrackIdx;
            curStartTime += 5;
          }
        }
        // 5. 音声ファイル
        else if (file.type.startsWith('audio/') || lowerName.endsWith('.mp3') || lowerName.endsWith('.wav') || lowerName.endsWith('.aac') || lowerName.endsWith('.m4a') || lowerName.endsWith('.flac') || lowerName.endsWith('.ogg')) {
          const added = await this.loadAudioFile(file);
          if (added) {
            if (dropTrackIdx !== null) added.trackIndex = dropTrackIdx;
          }
        }
        // 6. 3Dモデルファイル (.glb / .gltf)
        else if (lowerName.endsWith('.glb') || lowerName.endsWith('.gltf')) {
          const added = await this.load3DModelFile(file);
          if (added) {
            if (dropTrackIdx !== null) added.trackIndex = dropTrackIdx;
            curStartTime += 10;
          }
        }
      }

      this.recalculateTotalDuration();
      this.setupTimelineUI();
      this.requestRender();
    };

    // 1. プレビュー画面へのドロップイベント
    if (dropZone) {
      ['dragenter', 'dragover'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropZone.classList.add('drag-active');
          if (dragOverlay) dragOverlay.classList.remove('hidden');
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropZone.classList.remove('drag-active');
          if (dragOverlay) dragOverlay.classList.add('hidden');
        });
      });

      dropZone.addEventListener('drop', (e) => {
        handleFiles(e.dataTransfer.files, null, null);
      });
    }

    // 2. タイムラインエリアへの直接ドロップ (ドロップした位置・トラックへ配置)
    if (timelineZone) {
      ['dragenter', 'dragover'].forEach(name => {
        timelineZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          timelineZone.style.outline = '2px dashed var(--accent-cyan)';
        });
      });

      ['dragleave', 'drop'].forEach(name => {
        timelineZone.addEventListener(name, (e) => {
          e.preventDefault();
          e.stopPropagation();
          timelineZone.style.outline = 'none';
        });
      });

      timelineZone.addEventListener('drop', (e) => {
        const rect = timelineZone.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        const scrollOffset = timelineZone.scrollLeft;

        // ドロップしたX座標から開始秒数を算出
        const dropStartTime = Math.max(0, (clickX - 156 + scrollOffset) / this.state.zoom);

        // ドロップしたY座標からトラック行番号を算出 (各行 54px 刻み)
        const dropTrackIdx = Math.max(0, Math.floor((clickY - 26 + timelineZone.scrollTop) / 54));

        handleFiles(e.dataTransfer.files, dropStartTime, dropTrackIdx);
      });
    }

    this.canvas.addEventListener('pointerdown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;

      const clickX = ((e.clientX - rect.left) * scaleX) - (this.canvas.width / 2);
      const clickY = (this.canvas.height / 2) - ((e.clientY - rect.top) * scaleY);

      const curT = this.state.currentTime;
      const activeClips = this.state.tracks.filter(t =>
        !t.hidden &&
        !this.state.trackStates[t.trackIndex || 0]?.hidden &&
        !this.state.trackStates[t.trackIndex || 0]?.locked &&
        t.type !== 'audio' &&
        t.type !== 'background' &&
        curT >= t.startTime &&
        curT <= t.startTime + t.duration
      );

      // 主軸素材の回転ハンドルまたはリサイズハンドルのタッチ判定
      const primaryItem = this.selectedItem;
      let isHitRotateHandle = false;
      let isHitResizeHandle = false;

      if (primaryItem && primaryItem.transform) {
        const trans = this._animTransformsMap?.get(primaryItem.id) || this.calculateAnimTransform(primaryItem);
        const { w, h } = this.getClipDimensions(primaryItem, false);
        const scale = trans.scale || 1.0;
        const dx = clickX - (trans.x || 0);
        const dy = clickY - (trans.y || 0);

        let lx = dx;
        let ly = dy;
        if (trans.rotation) {
          const rad = (trans.rotation * Math.PI) / 180;
          lx = (dx * Math.cos(rad) - dy * Math.sin(rad));
          ly = (dx * Math.sin(rad) + dy * Math.cos(rad));
        }
        lx /= scale;
        ly /= scale;

        // 回転ハンドル判定 (上部 28px)
        const rotY = (h / 2) + (28 / scale);
        if (Math.hypot(lx, ly - rotY) < 18 / scale) {
          isHitRotateHandle = true;
        }

        // 四隅リサイズハンドル判定
        const corners = [
          [-w / 2, -h / 2],
          [w / 2, -h / 2],
          [w / 2, h / 2],
          [-w / 2, h / 2]
        ];
        if (corners.some(([cx, cy]) => Math.hypot(lx - cx, ly - cy) < 16 / scale)) {
          isHitResizeHandle = true;
        }
      }

      if (isHitRotateHandle && primaryItem) {
        this.saveState();
        this.dragState.isDraggingText = true;
        this.dragState.isRotating = true;
        this.dragState.isResizing = false;
        this.dragState.selectedClip = primaryItem;
        this.dragState.initialRotation = primaryItem.transform?.rotation || 0;
        this.dragState.initialAngle = Math.atan2(clickY - (primaryItem.transform?.y || 0), clickX - (primaryItem.transform?.x || 0));
        return;
      }

      if (isHitResizeHandle && primaryItem) {
        this.saveState();
        this.dragState.isDraggingText = true;
        this.dragState.isResizing = true;
        this.dragState.isRotating = false;
        this.dragState.selectedClip = primaryItem;
        this.dragState.initialScale = primaryItem.transform?.scale || 1.0;
        this.dragState.initialDist = Math.hypot(clickX - (primaryItem.transform?.x || 0), clickY - (primaryItem.transform?.y || 0)) || 1;
        return;
      }

      const targetClip = window.KeyframeEngine.hitTestClips(
        activeClips,
        clickX,
        clickY,
        (t) => this._animTransformsMap?.get(t.id) || this.calculateAnimTransform(t),
        (t) => this.getClipDimensions(t, false)
      );

      if (targetClip) {
        this.saveState();
        if (e.pointerId !== undefined && this.canvas.setPointerCapture) {
          try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
        }

        const isMulti = e.shiftKey || this.state.isMultiSelectMode;
        const isAlreadySelected = this.selectedItems.some(i => i === targetClip || (i.id && i.id === targetClip.id));

        if (isMulti) {
          if (isAlreadySelected) {
            this.selectedItems = [targetClip, ...this.selectedItems.filter(i => i !== targetClip && i.id !== targetClip.id)];
          } else {
            this.selectedItems.push(targetClip);
          }
        } else {
          if (!isAlreadySelected) {
            this.selectedItems = [targetClip];
          } else if (this.selectedItems.length > 1) {
            this.selectedItems = [targetClip, ...this.selectedItems.filter(i => i !== targetClip && i.id !== targetClip.id)];
          }
        }

        this.dragState.isDraggingText = true;
        this.dragState.isResizing = false;
        this.dragState.isRotating = false;
        this.dragState.selectedClip = targetClip;
        this.dragState.clipStartX = clickX - (targetClip.transform?.x || 0);
        this.dragState.clipStartY = clickY - (targetClip.transform?.y || 0);

        this.updateContextualToolbar();
        this.setupTimelineUI();
        this.requestRender();
      } else {
        this.deselectAll();
        this.requestRender();
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (this.dragState.isDraggingText && this.dragState.selectedClip) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;

        const curX = ((e.clientX - rect.left) * scaleX) - (this.canvas.width / 2);
        const curY = (this.canvas.height / 2) - ((e.clientY - rect.top) * scaleY);

        if (!this.dragState.selectedClip.transform) {
          this.dragState.selectedClip.transform = { scale: 1, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 };
        }

        if (this.dragState.isRotating) {
          // 直接回転ドラッグ
          const currentAngle = Math.atan2(curY - (this.dragState.selectedClip.transform.y || 0), curX - (this.dragState.selectedClip.transform.x || 0));
          let deltaDeg = ((this.dragState.initialAngle - currentAngle) * 180) / Math.PI;
          let newRot = Math.round(this.dragState.initialRotation + deltaDeg);
          if (this.state.isSnapEnabled && Math.abs(newRot % 45) < 4) {
            newRot = Math.round(newRot / 45) * 45;
          }
          this.dragState.selectedClip.transform.rotation = newRot;

          // 変形パネルUIのリアルタイム同期
          const rotSlider = document.getElementById('trans-rotate');
          const rotBadge = document.getElementById('val-trans-rotate');
          if (rotSlider) rotSlider.value = newRot;
          if (rotBadge) rotBadge.innerText = `${newRot}度`;
        } else if (this.dragState.isResizing) {
          // 四隅拡大縮小ドラッグ
          const currentDist = Math.hypot(curX - (this.dragState.selectedClip.transform.x || 0), curY - (this.dragState.selectedClip.transform.y || 0));
          const scaleRatio = currentDist / this.dragState.initialDist;
          const newScale = Math.max(0.1, Math.min(5.0, this.dragState.initialScale * scaleRatio));
          this.dragState.selectedClip.transform.scale = Math.round(newScale * 100) / 100;

          // 変形パネルUIのリアルタイム同期
          const scaleSlider = document.getElementById('trans-scale');
          const scaleBadge = document.getElementById('val-trans-scale');
          if (scaleSlider) scaleSlider.value = Math.round(newScale * 100);
          if (scaleBadge) scaleBadge.innerText = `${Math.round(newScale * 100)}%`;
        } else {
          // 通常移動ドラッグ
          let targetX = Math.round(curX - this.dragState.clipStartX);
          let targetY = Math.round(curY - this.dragState.clipStartY);

          if (this.state.isSnapEnabled) {
            if (Math.abs(targetX) < 15) targetX = 0;
            if (Math.abs(targetY) < 15) targetY = 0;
          }

          this.dragState.selectedClip.transform.x = targetX;
          this.dragState.selectedClip.transform.y = targetY;

          // 変形パネルUIのリアルタイム同期
          const xSlider = document.getElementById('trans-x');
          const ySlider = document.getElementById('trans-y');
          const xBadge = document.getElementById('val-trans-x');
          const yBadge = document.getElementById('val-trans-y');
          if (xSlider) xSlider.value = targetX;
          if (ySlider) ySlider.value = targetY;
          if (xBadge) xBadge.innerText = `${targetX}px`;
          if (yBadge) yBadge.innerText = `${targetY}px`;
        }

        // キーフレーム設定済み素材ならキーフレーム値を自動同期
        if (this.dragState.selectedClip.keyframes && this.dragState.selectedClip.keyframes.length > 0) {
          window.KeyframeEngine.addOrUpdateKeyframe(this.dragState.selectedClip, this.state.currentTime);
          this.renderClipKeyframeList();
        }

        this.checkClipsCollision();
        this.requestRender();
      } else if (!this.dragState.isDraggingText) {
        // マウスホバー時のカーソル形状判定
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const hoverX = ((e.clientX - rect.left) * scaleX) - (this.canvas.width / 2);
        const hoverY = (this.canvas.height / 2) - ((e.clientY - rect.top) * scaleY);

        const primaryItem = this.selectedItem;
        let cursor = 'default';

        if (primaryItem && primaryItem.transform) {
          const trans = this._animTransformsMap?.get(primaryItem.id) || this.calculateAnimTransform(primaryItem);
          const { w, h } = this.getClipDimensions(primaryItem, false);
          const scale = trans.scale || 1.0;
          const dx = hoverX - (trans.x || 0);
          const dy = hoverY - (trans.y || 0);

          let lx = dx, ly = dy;
          if (trans.rotation) {
            const rad = (trans.rotation * Math.PI) / 180;
            lx = (dx * Math.cos(rad) - dy * Math.sin(rad));
            ly = (dx * Math.sin(rad) + dy * Math.cos(rad));
          }
          lx /= scale; ly /= scale;

          const rotY = (h / 2) + (28 / scale);
          if (Math.hypot(lx, ly - rotY) < 18 / scale) {
            cursor = 'grab';
          } else {
            const corners = [[-w/2, -h/2], [w/2, -h/2], [w/2, h/2], [-w/2, h/2]];
            if (corners.some(([cx, cy]) => Math.hypot(lx - cx, ly - cy) < 16 / scale)) {
              cursor = 'nwse-resize';
            } else if (Math.abs(lx) <= w/2 && Math.abs(ly) <= h/2) {
              cursor = 'move';
            }
          }
        }
        this.canvas.style.cursor = cursor;
      }
    });

    window.addEventListener('pointerup', (e) => {
      if (this.dragState.isDraggingText) {
        if (e.pointerId !== undefined && this.canvas.releasePointerCapture) {
          try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        this.dragState.isDraggingText = false;
        this.dragState.isResizing = false;
        this.dragState.isRotating = false;
        this.dragState.selectedClip = null;
        this.saveState();
      }
    });

    window.addEventListener('pointerup', (e) => {
      if (this.dragState.isDraggingText) {
        if (e.pointerId !== undefined && this.canvas.releasePointerCapture) {
          try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        this.dragState.isDraggingText = false;
        this.dragState.isResizing = false;
        this.dragState.selectedClip = null;
        this.saveState(); // 移動・リサイズ確定時にUndo履歴を保存
      }
    });
  }
  // ★ クリップ登録の共通ファクトリメソッド
  addTrackClip(clipProps, mediaEntry = null) {
    const startTime = clipProps.startTime !== undefined ? clipProps.startTime : (this.state.currentTime || 0);
    const duration = clipProps.duration || 5;
    const clipId = clipProps.id || `${clipProps.type || 'clip'}-${Date.now()}`;

    const newClip = {
      id: clipId,
      startTime: startTime,
      duration: duration,
      originalDuration: clipProps.originalDuration || duration,
      trackIndex: clipProps.trackIndex !== undefined ? clipProps.trackIndex : this.getAvailableTrackIndex(startTime, duration),
      transform: clipProps.transform || { scale: 1.0, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 },
      ...clipProps
    };

    this.state.tracks.push(newClip);
    if (this._mediaRegistry) {
      this._mediaRegistry.set(clipId, mediaEntry || { element: newClip.element, model: newClip.model, waveform: newClip.waveform, mixer: newClip.mixer });
    }

    this.selectedItems = [newClip];
    this.enableControls();
    this.updateVolume();
    this.notifyUpdate();
    return newClip;
  }

  loadVideoFile(file, startTime = null) {
    if (!file) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.showLoading("動画を読み込み・解析中...");
      this.saveState();

      const video = document.createElement('video');
      video.playsInline = true;
      video.style.display = 'none';
      document.body.appendChild(video);

      const objectUrl = URL.createObjectURL(file);

      video.onloadedmetadata = async () => {
        video.pause();
        const rawDur = video.duration;
        const videoDuration = Math.max(0.1, Math.min(86400, isFinite(rawDur) && !isNaN(rawDur) ? rawDur : 10));

        const targetStartTime = startTime !== null ? startTime : this.state.currentTime;

        const newClip = this.addTrackClip({
          type: 'video',
          element: video,
          name: file.name,
          duration: videoDuration,
          originalDuration: videoDuration,
          startTime: targetStartTime
        });

        this.seekTo(newClip.startTime, true);

        try {
          const wf = await this.generateWaveformCanvas(file, this.state.volume.video);
          if (wf && newClip) {
            newClip.waveform = wf;
            this.setupTimelineUI();
          }
        } catch (err) {
          console.warn("動画の波形生成をスキップしました:", err);
        } finally {
          this.hideLoading();
          resolve(newClip);
        }
      };

      video.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        this.hideLoading();
        alert("動画の読み込みに失敗しました。形式を確認してください。");
        reject(new Error("動画の読み込みに失敗しました"));
      };

      video.src = objectUrl;
    });
  }

  async loadImageFile(file) {
    if (!file) return;
    this.showLoading("画像を読み込み中...");
    this.saveState();

    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      this.addTrackClip({ type: 'image', element: img, name: file.name, duration: 5 });
      this.hideLoading();
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      this.hideLoading();
      alert("画像の読み込みに失敗しました。");
    };
    img.src = objectUrl;
  }

  async loadAudioFile(file) {
    if (!file) return;
    this.showLoading("音声を解析・波形生成中...");
    this.saveState();

    try {
      const audio = new Audio(URL.createObjectURL(file));
      audio.preload = 'metadata';
      const wf = await this.generateWaveformCanvas(file, this.state.volume.bgm);
      const exactDur = wf?.duration || 10;
      this.addTrackClip({
        type: 'audio',
        element: audio,
        name: file.name,
        duration: exactDur,
        originalDuration: exactDur,
        waveform: wf
      });
    } catch (e) {
      alert("音声ファイルの読み込みに失敗しました: " + e.message);
    } finally {
      this.hideLoading();
    }
  }

  async load3DModelFile(file) {
    if (!file) return;
    this.showLoading("3Dモデルを読み込み中...");
    this.saveState();

    const url = URL.createObjectURL(file);
    try {
      const { model, mixer } = await this.threeEngine.loadGLTF(url);
      URL.revokeObjectURL(url);
      this.addTrackClip({ type: '3d', model, mixer, name: file.name, duration: 10, transform: { scale: 0.5, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 }, materialProps: { color: '#ffffff', metalness: 0.5, roughness: 0.5, wireframe: false } });
    } catch (err) { alert("3Dモデル読み込み失敗: " + err.message); }
    finally { this.hideLoading(); }
  }
  createPrimitive3DShape(shapeType, colorHex) {
    this.saveState();
    const isParticle = shapeType.startsWith('particles-');
    const mesh = isParticle
      ? this.threeEngine?.createParticleSystem(shapeType.replace('particles-', ''), 250)
      : this.threeEngine?.createPrimitive(shapeType, colorHex);

    this.addTrackClip({
      type: '3d',
      model: mesh,
      name: `3D ${shapeType}`,
      duration: 5,
      animMode: isParticle ? 'spin' : 'none',
      materialProps: { color: colorHex, metalness: 0.4, roughness: 0.3, wireframe: false, shaderType: 'standard' },
      transform: { scale: 0.5, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 }
    });
  }
  createBlankProject(bgColor, duration) {
    this.state.bgColor = bgColor;
    this.state.tracks = [{
      id: 'clip-bg',
      type: 'background',
      name: `背景 (${duration}秒)`,
      startTime: 0,
      duration: duration,
      transform: { scale: 1.0, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 }
    }];

    this.enableControls();
    this.notifyUpdate();
    this.seekTo(0, true);
  }
  // ★ 音声波形生成を AudioSynthEngine に委譲
  async generateWaveformCanvas(file, volumeMultiplier = 1.0, width = 800, height = 60) {
    if (!this.synthEngine) return null;
    return await this.synthEngine.generateWaveformCanvas(file, volumeMultiplier, width, height);
  }

  // ★ 音量やピッチが変更された時に全波形を再生成してUIを更新する
  async redrawAllWaveforms() {
    for (let t of this.state.tracks) {
      if ((t.type === 'video' || t.type === 'audio') && t.waveform && t.waveform.originalFile) {
        const volMultiplier = t.type === 'video' ? this.state.volume.video : this.state.volume.bgm;
        const wf = await this.generateWaveformCanvas(t.waveform.originalFile, volMultiplier);
        if (wf) t.waveform = wf;
      }
    }
    this.setupTimelineUI(); // 波形画像を更新
  }

  getNewClipStartTime() {
    // 常に現在赤針（赤線）が立っている時間を開始位置にする
    return this.state.currentTime || 0;
  }

  // グリーディ区間スケジューリングによる最適空きトラック探索（ゼロアロケーション版）
  getAvailableTrackIndex(startTime, duration = 3) {
    const endTime = startTime + duration;
    const tracks = this.state.tracks;

    // トラック 0 (V1) から順に空いているトラックを探索
    for (let trackIdx = 0; trackIdx < 30; trackIdx++) {
      let hasConflict = false;

      for (let i = 0; i < tracks.length; i++) {
        const c = tracks[i];
        if ((c.trackIndex || 0) === trackIdx) {
          const cStart = c.startTime || 0;
          const cEnd = cStart + (c.duration || 0);
          if (startTime < cEnd && endTime > cStart) {
            hasConflict = true;
            break;
          }
        }
      }

      if (!hasConflict) {
        return trackIdx;
      }
    }
    return 0;
  }
  updateAspectRatio() {
    const customInputs = document.getElementById('custom-res-inputs');

    // カスタム指定時のUI切り替え
    if (this.state.aspectRatio === 'custom') {
      if (customInputs) customInputs.classList.remove('hidden');
      const wInput = document.getElementById('custom-width');
      const hInput = document.getElementById('custom-height');
      let customW = parseInt(wInput?.value) || 1080;
      let customH = parseInt(hInput?.value) || 1920;

      // ★ H.264 エンコード互換性のため偶数（2の倍数）にクランプ
      if (customW % 2 !== 0) {
        customW += 1;
        if (wInput) wInput.value = customW;
      }
      if (customH % 2 !== 0) {
        customH += 1;
        if (hInput) hInput.value = customH;
      }

      this.canvas.width = customW;
      this.canvas.height = customH;
      return;
    } else {
      if (customInputs) customInputs.classList.add('hidden');
    }

    // 拡張された解像度テーブル
    const resolutions = {
      '9:16': { w: 720, h: 1280 },   // 縦型 720p
      '9:16-hd': { w: 1080, h: 1920 },   // 縦型 フルHD 1080p
      '9:16-4k': { w: 2160, h: 3840 },   // 縦型 4K 2160p
      '16:9': { w: 1920, h: 1080 },   // 横型 フルHD 1080p
      '16:9-2k': { w: 2560, h: 1440 },   // 横型 2K 1440p
      '16:9-4k': { w: 3840, h: 2160 },   // 横型 4K 2160p
      '1:1': { w: 1080, h: 1080 },   // スクエア 1080p
      '4:5': { w: 1080, h: 1350 },   // Instagram 縦型フィード
      '4:3': { w: 1440, h: 1080 },   // 4:3 SD
      '21:9': { w: 2560, h: 1080 }    // シネマスコープ
    };

    const res = resolutions[this.state.aspectRatio] || resolutions['9:16-hd'];
    this.canvas.width = res.w;
    this.canvas.height = res.h;

    // 3Dカメラのアスペクト比とレンダラーサイズを同期
    if (this.threeEngine) {
      this.threeEngine.updateSize(this.canvas.width, this.canvas.height);
    }

    this.requestRender();
  }

setupTimelineUI() {
    const totalWidth = 156 + (this.state.duration * this.state.zoom);
    this.timelineTracks.style.width = `${totalWidth}px`;

    this.updateTimelinePadding();

    const hasSelection = this.selectedItems && this.selectedItems.length > 0;
    this.timelineContainer.classList.toggle('has-selection', hasSelection);

    this.renderTimeRuler();

    const videoTracksContainer = document.getElementById('video-tracks');

    const checkIsSelected = (targetItem) => {
      if (!this.selectedItems || this.selectedItems.length === 0) return false;
      return this.selectedItems.some(item => item === targetItem || (item.id && targetItem.id && item.id === targetItem.id));
    };

    // トラック行生成ヘルパー（各行の中に固定ヘッダーを1対1で内包）
    const createTrackRowWithHeader = (trackIndex) => {
      const trackRow = document.createElement('div');
      trackRow.className = 'video-track-row';
      trackRow.id = `video-track-${trackIndex}`;

      const header = document.createElement('div');
      header.className = 'track-header-cell';
      header.id = `track-header-cell-${trackIndex}`;

      const labelSpan = document.createElement('span');
      labelSpan.className = 'track-label-text';
      labelSpan.innerText = `V${trackIndex + 1}`;
      header.appendChild(labelSpan);

      const btnGroup = document.createElement('div');
      btnGroup.className = 'track-header-buttons';

      // 表示/非表示
      const hideBtn = document.createElement('button');
      hideBtn.className = 'track-btn-toggle btn-track-hide';
      hideBtn.title = 'トラックの表示/非表示';
      hideBtn.innerText = '表示';
      hideBtn.onclick = (e) => {
        e.stopPropagation();
        this.saveState();
        if (!this.state.trackStates[trackIndex]) this.state.trackStates[trackIndex] = { locked: false, hidden: false, muted: false };
        this.state.trackStates[trackIndex].hidden = !this.state.trackStates[trackIndex].hidden;
        this.setupTimelineUI();
        this.requestRender();
      };
      btnGroup.appendChild(hideBtn);

      // ロック
      const lockBtn = document.createElement('button');
      lockBtn.className = 'track-btn-toggle btn-track-lock';
      lockBtn.title = 'トラックのロック/解除';
      lockBtn.innerText = 'ロック';
      lockBtn.onclick = (e) => {
        e.stopPropagation();
        this.saveState();
        if (!this.state.trackStates[trackIndex]) this.state.trackStates[trackIndex] = { locked: false, hidden: false, muted: false };
        this.state.trackStates[trackIndex].locked = !this.state.trackStates[trackIndex].locked;
        if (this.state.trackStates[trackIndex].locked) {
          this.selectedItems = this.selectedItems.filter(item => (item.trackIndex || 0) !== trackIndex);
          this.updateContextualToolbar();
        }
        this.setupTimelineUI();
      };
      btnGroup.appendChild(lockBtn);

      // 消音
      const muteBtn = document.createElement('button');
      muteBtn.className = 'track-btn-toggle btn-track-mute';
      muteBtn.title = 'トラックの消音/解除';
      muteBtn.innerText = '消音';
      muteBtn.onclick = (e) => {
        e.stopPropagation();
        this.saveState();
        if (!this.state.trackStates[trackIndex]) this.state.trackStates[trackIndex] = { locked: false, hidden: false, muted: false };
        this.state.trackStates[trackIndex].muted = !this.state.trackStates[trackIndex].muted;
        this.updateVolume();
        this.setupTimelineUI();
      };
      btnGroup.appendChild(muteBtn);

      header.appendChild(btnGroup);
      trackRow.appendChild(header);
      return trackRow;
    };

    const makeClipDraggable = (clipEl, clip, e) => {
      const trackIdx = clip.trackIndex || 0;
      if (this.state.trackStates[trackIdx]?.locked) {
        return;
      }

      // ★ ドラッグ開始前の位置をUndo履歴に記録（移動を確実に元に戻せるようにする）
      this.saveState();

      const isAlreadySelected = this.selectedItems.some(i => i === clip || (i.id && i.id === clip.id));
      const isMulti = e.shiftKey || this.state.isMultiSelectMode;


      if (isMulti) {
        if (!isAlreadySelected) {
          this.selectedItems.push(clip);
        } else {
          this.selectedItems = [clip, ...this.selectedItems.filter(i => i !== clip && i.id !== clip.id)];
        }
      } else {
        if (!isAlreadySelected) {
          this.selectedItems = [clip];
        } else if (this.selectedItems.length > 1) {
          this.selectedItems = [clip, ...this.selectedItems.filter(i => i !== clip && i.id !== clip.id)];
        }
      }

      let longPressTimer = null;
      if (!isMulti && !isAlreadySelected) {
        longPressTimer = setTimeout(() => {
          if (!this.selectedItems.some(i => i === clip || (i.id && i.id === clip.id))) {
            this.selectedItems.push(clip);
            if (navigator.vibrate) navigator.vibrate([15, 30, 15]);
            this.updateContextualToolbar();
            this.setupTimelineUI();
          }
        }, 400);
      }

      this.updateContextualToolbar();
      this.setupTimelineUI();

      // パネルが開いている場合のみ内部データを同期 (勝手に開く処理は完全削除)
      if (document.getElementById('panel-caption-editor') && !document.getElementById('panel-caption-editor').classList.contains('hidden')) {
        this.initQuillEditor();
      }

      let dragStartX = e.clientX;
      let dragStartY = e.clientY;

      const initialPositions = this.selectedItems.map(item => ({
        clip: item,
        startT: item.startTime || 0,
        trackIdx: item.trackIndex || 0
      }));

      if (e.pointerId !== undefined && clipEl.setPointerCapture) {
        try { clipEl.setPointerCapture(e.pointerId); } catch (err) {}
      }

      const onClipMove = (moveEvent) => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }

        const deltaX = moveEvent.clientX - dragStartX;
        const deltaY = moveEvent.clientY - dragStartY;
        const deltaTime = deltaX / this.state.zoom;
        const trackShift = Math.round(deltaY / 54);

        const targetPos = initialPositions.find(p => p.clip === clip);
        const clipDur = targetPos?.clip?.duration || clip.duration || 0;
        let rawTargetStart = Math.max(0, (targetPos ? targetPos.startT : clip.startTime) + deltaTime);

        let finalStart = rawTargetStart;
        if (this.state.isSnapEnabled) {
          finalStart = this.applySnapping(rawTargetStart, clip.id, clipDur);
        }
        const effectiveDeltaTime = finalStart - (targetPos ? targetPos.startT : clip.startTime);

        let maxClipEnd = this.state.duration;

        initialPositions.forEach(pos => {
          let newStart = Math.max(0, pos.startT + effectiveDeltaTime);
          pos.clip.startTime = newStart;

          let newTrackIdx = Math.max(0, Math.min(30, pos.trackIdx + trackShift));
          pos.clip.trackIndex = newTrackIdx;

          maxClipEnd = Math.max(maxClipEnd, newStart + pos.clip.duration);
        });

        if (maxClipEnd > this.state.duration) {
          this.state.duration = maxClipEnd;
          this.timelineTracks.style.width = `${140 + (maxClipEnd * this.state.zoom) + 120}px`;
        }

        this.selectedItems.forEach(item => {
          const el = this._clipDomMap.get(item.id) || document.querySelector(`[data-clip-id="${item.id}"]`);
          if (el) {
            el.style.left = '0px';
            el.style.transform = `translate3d(${156 + (item.startTime * this.state.zoom)}px, 0, 0)`;
            el.style.width = `${item.duration * this.state.zoom}px`;

            let targetTrackRow = document.getElementById(`video-track-${item.trackIndex}`);
            if (!targetTrackRow && videoTracksContainer) {
              for (let trk = videoTracksContainer.children.length; trk <= item.trackIndex; trk++) {
                const newRow = createTrackRowWithHeader(trk);
                videoTracksContainer.appendChild(newRow);
              }
              targetTrackRow = document.getElementById(`video-track-${item.trackIndex}`);
            }
            if (targetTrackRow && el.parentElement !== targetTrackRow) {
              targetTrackRow.appendChild(el);
            }
          }
        });
        this.updateSelectedClipTimeUI();
        this.requestRender();
      };

      const onClipUp = (upEvent) => {
        if (longPressTimer) clearTimeout(longPressTimer);
        if (upEvent.pointerId !== undefined && clipEl.releasePointerCapture) {
          try { clipEl.releasePointerCapture(upEvent.pointerId); } catch (err) {}
        }
        const guideEl = document.getElementById('snap-guide-line');
        if (guideEl) guideEl.classList.add('hidden');

        this.saveState();
        window.removeEventListener('pointermove', onClipMove);
        window.removeEventListener('pointerup', onClipUp);
        window.removeEventListener('pointercancel', onClipUp);
        window.removeEventListener('touchend', onClipUp);
        this.recalculateTotalDuration();
        this.setupTimelineUI();
      };

      window.addEventListener('pointermove', onClipMove);
      window.addEventListener('pointerup', onClipUp);
      window.addEventListener('pointercancel', onClipUp);
      window.addEventListener('touchend', onClipUp);
    };

    if (videoTracksContainer) {
      const usedTracks = this.state.tracks.map(t => t.trackIndex || 0);
      const highestTrackInUse = usedTracks.length > 0 ? Math.max(...usedTracks) : 2;
      const targetTrackCount = Math.max(3, highestTrackInUse + 1);

      while (videoTracksContainer.children.length < targetTrackCount) {
        const i = videoTracksContainer.children.length;
        const trackRow = createTrackRowWithHeader(i);
        videoTracksContainer.appendChild(trackRow);
      }

      while (videoTracksContainer.children.length > targetTrackCount) {
        videoTracksContainer.removeChild(videoTracksContainer.lastElementChild);
      }

      // トラック状態クラスとボタンテキストの同期
      for (let i = 0; i < targetTrackCount; i++) {
        const row = videoTracksContainer.children[i];
        const tState = this.state.trackStates[i] || { locked: false, hidden: false, muted: false };

        if (row) {
          row.classList.toggle('is-track-locked', !!tState.locked);
          row.classList.toggle('is-track-hidden', !!tState.hidden);

          const hBtn = row.querySelector('.btn-track-hide');
          const lBtn = row.querySelector('.btn-track-lock');
          const mBtn = row.querySelector('.btn-track-mute');

          if (hBtn) {
            hBtn.innerText = tState.hidden ? '非表示' : '表示';
            hBtn.classList.toggle('active', !!tState.hidden);
          }
          if (lBtn) {
            lBtn.innerText = tState.locked ? 'ロック中' : 'ロック';
            lBtn.classList.toggle('active', !!tState.locked);
          }
          if (mBtn) {
            mBtn.innerText = tState.muted ? '消音中' : '消音';
            mBtn.classList.toggle('active', !!tState.muted);
          }
        }
      }

      // タイムラインから削除されたクリップDOMの除去
      const currentTrackIds = new Set(this.state.tracks.map(t => String(t.id)));
      for (const [id, domEl] of this._clipDomMap.entries()) {
        if (!currentTrackIds.has(String(id))) {
          domEl.remove();
          this._clipDomMap.delete(id);
        }
      }

      // 各クリップ要素の統一差分レンダリング
      this.state.tracks.forEach(clip => {
        if (clip.trackIndex === undefined) clip.trackIndex = 0;
        const targetRow = document.getElementById(`video-track-${clip.trackIndex}`) || videoTracksContainer.children[0];
        const isSelected = checkIsSelected(clip);
        const isPrimary = this.selectedItems?.[0]?.id === clip.id;
        const hasTransition = clip.animProps && (clip.animProps.inAnim !== 'none' || clip.animProps.outAnim !== 'none');

        let clipEl = this._clipDomMap.get(clip.id);
        const isNew = !clipEl;

        if (isNew) {
          clipEl = document.createElement('div');
          clipEl.setAttribute('data-clip-id', clip.id);
          clipEl.appendChild(document.createElement('span'));

          const handleLeft = document.createElement('div');
          handleLeft.className = 'trim-handle left';
          const handleRight = document.createElement('div');
          handleRight.className = 'trim-handle right';
          clipEl.appendChild(handleLeft);
          clipEl.appendChild(handleRight);

          handleLeft.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.initTrim(e, clipEl._clip, 'left'); });
          handleRight.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.initTrim(e, clipEl._clip, 'right'); });

          clipEl.addEventListener('pointerdown', (e) => {
            if (e.target.classList.contains('trim-handle')) return;
            e.stopPropagation();
            makeClipDraggable(clipEl, clipEl._clip, e);
          });

          clipEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const currentClip = clipEl._clip || clip;
            const panelMap = { text: 'panel-caption-editor', '3d': 'panel-3d', audio: 'panel-audio', shape: 'panel-shape', rect: 'panel-shape', circle: 'panel-shape' };
            const pId = panelMap[currentClip.type] || 'panel-transform';
            if (pId === 'panel-3d') this.syncAndToggle3DPanel();
            else if (pId === 'panel-shape') this.syncAndToggleShapePanel();
            else if (pId === 'panel-transform') this.syncAndToggleTransformPanel();
            else this.toggleSubPanel(pId);
          });

          this._clipDomMap.set(clip.id, clipEl);
        }

        clipEl._clip = clip;

        const typeClass = { image: 'image-clip', shape: 'image-clip', background: 'bg-clip', text: 'text-clip', audio: 'audio-clip' }[clip.type] || '';
        clipEl.className = `timeline-clip ${typeClass} ${isPrimary ? 'selected-primary' : (isSelected ? 'selected' : '')} ${hasTransition ? 'has-transition' : ''} ${clip.hidden ? 'is-muted-clip' : ''}`;
        clipEl.style.left = '0px';
        clipEl.style.transform = `translate3d(${156 + ((clip.startTime || 0) * this.state.zoom)}px, 0, 0)`;
        clipEl.style.width = `${(clip.duration || 1) * this.state.zoom}px`;

        const label = clipEl.querySelector('span');
        const newText = String(clip.name || clip.text || clip.type);
        if (label && label.innerText !== newText) label.innerText = newText;

        if (clip.waveform?.canvas) {
          let wfEl = clipEl.querySelector('.waveform-canvas');
          if (!wfEl) { wfEl = document.createElement('canvas'); wfEl.className = 'waveform-canvas'; clipEl.appendChild(wfEl); }
          if (wfEl._sourceCanvas !== clip.waveform.canvas) {
            wfEl.width = clip.waveform.canvas.width; wfEl.height = clip.waveform.canvas.height;
            wfEl.getContext('2d').drawImage(clip.waveform.canvas, 0, 0);
            wfEl._sourceCanvas = clip.waveform.canvas;
          }
        }

        clipEl.querySelectorAll('.transition-ribbon').forEach(r => r.remove());
        if (clip.animProps) {
          const totalDur = Math.max(0.1, clip.duration || 1);

          if (clip.animProps.inAnim && clip.animProps.inAnim !== 'none') {
            const inDur = Math.min(clip.animProps.inDuration || 0.8, totalDur / 2);
            const inRibbon = document.createElement('div');
            inRibbon.className = 'transition-ribbon in';
            inRibbon.style.width = `${(inDur / totalDur) * 100}%`;
            inRibbon.title = `In: ${clip.animProps.inAnim} (${inDur.toFixed(1)}s)`;
            clipEl.appendChild(inRibbon);
          }

          if (clip.animProps.outAnim && clip.animProps.outAnim !== 'none') {
            const outDur = Math.min(clip.animProps.outDuration || 0.8, totalDur / 2);
            const outRibbon = document.createElement('div');
            outRibbon.className = 'transition-ribbon out';
            outRibbon.style.width = `${(outDur / totalDur) * 100}%`;
            outRibbon.title = `Out: ${clip.animProps.outAnim} (${outDur.toFixed(1)}s)`;
            clipEl.appendChild(outRibbon);
          }
        }

        clipEl.querySelectorAll('.clip-keyframe-marker').forEach(m => m.remove());
        if (clip.type === 'text' && Array.isArray(clip.textKeyframes)) {
          clip.textKeyframes.forEach(kf => {
            if (kf.time > 0 && kf.time < clip.duration) {
              const marker = document.createElement('div');
              marker.className = 'clip-keyframe-marker';
              marker.style.left = `${(kf.time / clip.duration) * 100}%`;
              clipEl.appendChild(marker);
            }
          });
        }

        if (clipEl.parentElement !== targetRow && targetRow) targetRow.appendChild(clipEl);
      });
    }

    if (typeof this.requestRender === 'function') {
      this.requestRender();
    }
  }

  initTrim(e, clip, handleType) {
    this.pause();
    this.saveState();
    this.dragState.isTrimming = true;
    this.dragState.trimTarget = handleType;
    this.dragState.clipStartX = e.clientX;
    this.dragState.clipStartTime = clip.startTime;
    this.dragState.clipStartDuration = clip.duration;
    this.dragState.clipStartOffset = clip.mediaOffset || 0;

    const origStart = this.dragState.clipStartTime;
    const origEnd = origStart + this.dragState.clipStartDuration;
    const isMedia = clip.type === 'video' || clip.type === 'audio';
    const pitch = this.state.volume.pitch || 1.0;

    const handleEl = e.target;
    if (e.pointerId !== undefined && handleEl.setPointerCapture) {
      try { handleEl.setPointerCapture(e.pointerId); } catch (err) {}
    }

    const targetEl = this._clipDomMap.get(clip.id) || document.querySelector(`[data-clip-id="${clip.id}"]`);

    const onTrimMove = (moveEvent) => {
      if (!this.dragState.isTrimming) return;
      const deltaX = moveEvent.clientX - this.dragState.clipStartX;
      const deltaTime = deltaX / this.state.zoom;

      if (handleType === 'right') {
        let rawTargetEndTime = origEnd + deltaTime;
        if (this.state.isSnapEnabled) {
          rawTargetEndTime = this.applySnapping(rawTargetEndTime, clip.id);
        }

        if (rawTargetEndTime >= origStart) {
          // 通常の右伸ばし・縮め
          let newDuration = Math.max(0.1, rawTargetEndTime - origStart);
          if (isMedia && clip.element?.duration) {
            const maxAvailable = (clip.element.duration - (this.dragState.clipStartOffset || 0)) / pitch;
            newDuration = Math.min(newDuration, Math.max(0.1, maxAvailable));
          }
          clip.startTime = origStart;
          clip.duration = newDuration;
          if (isMedia) clip.mediaOffset = this.dragState.clipStartOffset;
        } else {
          // 開始点を左へ突き抜けた場合の反転トリミング（左方向へ伸長）
          let newStartTime = Math.max(0, rawTargetEndTime);
          if (isMedia) {
            const maxExtendLeft = (this.dragState.clipStartOffset || 0) / pitch;
            const minAllowed = Math.max(0, origStart - maxExtendLeft);
            newStartTime = Math.max(minAllowed, newStartTime);
            clip.mediaOffset = Math.max(0, this.dragState.clipStartOffset - ((origStart - newStartTime) * pitch));
          }
          clip.startTime = newStartTime;
          clip.duration = Math.max(0.1, origStart - newStartTime);
        }
      } else if (handleType === 'left') {
        let rawTargetStartTime = origStart + deltaTime;
        if (this.state.isSnapEnabled) {
          rawTargetStartTime = this.applySnapping(rawTargetStartTime, clip.id);
        }

        if (rawTargetStartTime <= origEnd) {
          // 通常の左伸ばし・縮め
          let minAllowed = 0;
          if (isMedia) {
            const maxExtendLeft = (this.dragState.clipStartOffset || 0) / pitch;
            minAllowed = Math.max(0, origStart - maxExtendLeft);
          }
          let newStartTime = Math.max(minAllowed, rawTargetStartTime);
          clip.startTime = newStartTime;
          clip.duration = Math.max(0.1, origEnd - newStartTime);
          if (isMedia) {
            clip.mediaOffset = Math.max(0, this.dragState.clipStartOffset + ((newStartTime - origStart) * pitch));
          }
        } else {
          // 終了点を右へ突き抜けた場合の反転トリミング（右方向へ伸長）
          let newEndTime = rawTargetStartTime;
          let newDuration = Math.max(0.1, newEndTime - origEnd);
          if (isMedia && clip.element?.duration) {
            const currentOffset = this.dragState.clipStartOffset + (this.dragState.clipStartDuration * pitch);
            const maxAvailable = (clip.element.duration - currentOffset) / pitch;
            newDuration = Math.min(newDuration, Math.max(0.1, maxAvailable));
          }
          clip.startTime = origEnd;
          clip.duration = newDuration;
          if (isMedia) {
            clip.mediaOffset = Math.min(clip.element.duration - 0.1, this.dragState.clipStartOffset + (this.dragState.clipStartDuration * pitch));
          }
        }
      }

      // トランジション時間の安全クランプ
      if (clip.animProps) {
        const halfDur = clip.duration / 2;
        clip.animProps.inDuration = Math.min(clip.animProps.inDuration || 0.8, halfDur);
        clip.animProps.outDuration = Math.min(clip.animProps.outDuration || 0.8, halfDur);
      }

      // タイムライン全体の幅をリアルタイム拡張
      const clipEnd = clip.startTime + clip.duration;
      if (clipEnd > this.state.duration) {
        this.state.duration = clipEnd;
        this.timelineTracks.style.width = `${156 + (clipEnd * this.state.zoom) + 200}px`;
      }

      // DOM位置と幅を 156px 基準でリアルタイム更新
      if (targetEl) {
        targetEl.style.left = '0px';
        targetEl.style.transform = `translate3d(${156 + (clip.startTime * this.state.zoom)}px, 0, 0)`;
        targetEl.style.width = `${clip.duration * this.state.zoom}px`;
      }

      this.updateSelectedClipTimeUI();
      this.requestRender();
    };

    const onTrimUp = (upEvent) => {
      if (upEvent.pointerId !== undefined && handleEl.releasePointerCapture) {
        try { handleEl.releasePointerCapture(upEvent.pointerId); } catch (err) {}
      }
      this.dragState.isTrimming = false;
      window.removeEventListener('pointermove', onTrimMove);
      window.removeEventListener('pointerup', onTrimUp);
      window.removeEventListener('pointercancel', onTrimUp);

      const currentPitch = this.state.volume.pitch || 1.0;
      clip.originalDuration = clip.duration * currentPitch;

      this.recalculateTotalDuration();
      this.setupTimelineUI();
      this.requestRender();
    };

    window.addEventListener('pointermove', onTrimMove);
    window.addEventListener('pointerup', onTrimUp);
    window.addEventListener('pointercancel', onTrimUp);
  }

  recalculateTotalDuration() {
    const tracks = this.state.tracks;
    let maxDuration = 0;

    for (let i = 0; i < tracks.length; i++) {
      const c = tracks[i];
      const s = isFinite(c.startTime) ? c.startTime : 0;
      const d = isFinite(c.duration) ? c.duration : 5;
      const end = s + d;
      if (end > maxDuration) maxDuration = end;
    }

    if (!isFinite(maxDuration) || isNaN(maxDuration) || maxDuration <= 0) {
      maxDuration = 10;
    }
    const clampedMax = Math.min(86400, maxDuration);

    if (this.state.duration !== clampedMax) {
      this.state.duration = clampedMax;
      if (this.timelineTracks) {
        this.timelineTracks.style.width = `${156 + (clampedMax * this.state.zoom)}px`;
      }
    }

    // 素材短縮時に赤針が終端を超えていたら安全に引き戻し
    if (this.state.currentTime > this.state.duration) {
      this.seekTo(this.state.duration, true);
    }
  }
  requestRender() {
    this.isNeedsRender = true;
    if (!this.isLoopRunning) {
      this.isLoopRunning = true;
      requestAnimationFrame(this.renderLoop.bind(this));
    }
  }
  seekTo(seconds, forceSetVideo = false) {
    const maxDur = Math.max(0, this.state.duration || 0);
    const clampedTime = Math.max(0, Math.min(seconds, maxDur));

    this.state.currentTime = clampedTime;

    // 赤針が現在の視野外にある場合は自動でスクロールして赤針を表示
    if (this.timelineContainer && !this.state.isPlaying) {
      const posX = 156 + (clampedTime * this.state.zoom);
      const scrollLeft = this.timelineContainer.scrollLeft;
      const viewWidth = this.timelineContainer.clientWidth;

      if (posX < scrollLeft + 156) {
        this.timelineContainer.scrollLeft = Math.max(0, posX - 156);
      } else if (posX > scrollLeft + viewWidth - 50) {
        this.timelineContainer.scrollLeft = posX - viewWidth + 100;
      }
    }

    if (forceSetVideo) {
      const pitch = this.state.volume.pitch || 1.0;
      const tracks = this.state.tracks;

      for (let i = 0; i < tracks.length; i++) {
        const clip = tracks[i];

        // 1. 通常の動画・音声クリップのシーク同期
        if ((clip.type === 'video' || clip.type === 'audio') && clip.element) {
          const el = clip.element;
          const inRange = clampedTime >= clip.startTime && clampedTime <= clip.startTime + clip.duration;

          if (inRange) {
            const offset = clip.mediaOffset || 0;
            const targetMediaTime = Math.max(0, (offset + (clampedTime - clip.startTime)) * pitch);
            const maxMediaDur = el.duration || Infinity;
            const safeTime = Math.min(targetMediaTime, isFinite(maxMediaDur) ? maxMediaDur : targetMediaTime);

            const timeDiff = Math.abs(el.currentTime - safeTime);
            if (timeDiff >= 0.03) {
              // シーク完了時にプレビューを確実に更新するリスナーを一度だけバインド
              if (!el._hasSeekedListener) {
                el._hasSeekedListener = true;
                el.addEventListener('seeked', () => {
                  if (!this.state.isPlaying) {
                    this.requestRender();
                  }
                });
              }

              if (typeof el.fastSeek === 'function' && !this.state.isPlaying) {
                el.fastSeek(safeTime);
              } else {
                el.currentTime = safeTime;
              }
            }

            if (!this.state.isPlaying && !el.paused) {
              el.pause();
            }
          } else {
            if (!el.paused) el.pause();
            if (Math.abs(el.currentTime - (clip.mediaOffset || 0)) > 0.05) {
              el.currentTime = (clip.mediaOffset || 0);
            }
          }
        }


        // 2. 図形内にはめ込まれた動画メディアのシーク同期
        if (clip.innerMediaElement && clip.innerMediaElement.tagName === 'VIDEO') {
          const inRange = clampedTime >= clip.startTime && clampedTime <= clip.startTime + clip.duration;
          if (inRange) {
            const relT = Math.max(0, clampedTime - clip.startTime);
            const mediaDur = clip.innerMediaElement.duration || Infinity;
            clip.innerMediaElement.currentTime = isFinite(mediaDur) ? relT % mediaDur : relT;
          } else {
            if (!clip.innerMediaElement.paused) clip.innerMediaElement.pause();
          }
        }
      }

      // 3. 全編共通背景動画のシーク同期
      if (this.state.bgMedia && this.state.bgMedia.type === 'video' && this.state.bgMedia.element) {
        const bgVid = this.state.bgMedia.element;
        const bgDur = bgVid.duration || Infinity;
        bgVid.currentTime = isFinite(bgDur) ? clampedTime % bgDur : clampedTime;
      }
    }

    this.updateTimelineUIOnly();
    this.requestRender(); // 静止中のシークでも画面を即時更新
  }
  updateTimelinePadding() {
    this.timelineTracks.style.paddingLeft = '0px';
    this.timelineTracks.style.paddingRight = '120px';
  }

  updateTimelineUIOnly() {
    const playheadEl = document.querySelector('.playhead');
    const posX = 156 + (this.state.currentTime * this.state.zoom);

    if (playheadEl) {
      playheadEl.style.transform = `translate3d(${posX}px, 0, 0)`;
    }

    this.timelineTracks.style.transform = 'translate3d(0, 0, 0)';

    // 再生中の自動水平スクロール追従
    if (this.timelineContainer && this.state.isPlaying) {
      const scrollLeft = this.timelineContainer.scrollLeft;
      const viewWidth = this.timelineContainer.clientWidth;

      if (posX > scrollLeft + viewWidth - 60) {
        this.timelineContainer.scrollLeft = posX - viewWidth + 120;
      } else if (posX < scrollLeft + 156) {
        this.timelineContainer.scrollLeft = Math.max(0, posX - 156);
      }
    }

    this.renderTimeRuler();
    this.updateTimeDisplay();
  }
  updateClipAudioNodes(clip) {
    if (!clip || !clip.element) return;
    const ctx = this.getAudioContext();
    if (!ctx) return;

    if (!clip._audioNodes) {
      try {
        // メディア要素に既に作られたソースノードがあれば再利用し、多重接続による InvalidStateError を完全遮断
        let source = clip.element._mediaElementSourceNode;
        if (!source) {
          source = ctx.createMediaElementSource(clip.element);
          clip.element._mediaElementSourceNode = source;
        }

        const lowFilter = ctx.createBiquadFilter();
        lowFilter.type = 'lowshelf';
        lowFilter.frequency.value = 100;

        const midFilter = ctx.createBiquadFilter();
        midFilter.type = 'peaking';
        midFilter.frequency.value = 1000;
        midFilter.Q.value = 1.0;

        const highFilter = ctx.createBiquadFilter();
        highFilter.type = 'highshelf';
        highFilter.frequency.value = 8000;

        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -20;
        compressor.knee.value = 10;
        compressor.ratio.value = 4;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.050;

        const gain = ctx.createGain();

        // 直列接続: Source -> LowEQ -> MidEQ -> HighEQ -> Gain -> Destination
        source.connect(lowFilter);
        lowFilter.connect(midFilter);
        midFilter.connect(highFilter);
        highFilter.connect(gain);
        gain.connect(ctx.destination);

        clip._audioNodes = { source, lowFilter, midFilter, highFilter, compressor, gain, isCompConnected: false };
      } catch (e) {
        // 既に接続済みなどの例外を安全にガード
        return;
      }
    }

    const nodes = clip._audioNodes;
    const eq = clip.eq || { low: 0, mid: 0, high: 0 };

    nodes.lowFilter.gain.setValueAtTime(eq.low || 0, ctx.currentTime);
    nodes.midFilter.gain.setValueAtTime(eq.mid || 0, ctx.currentTime);
    nodes.highFilter.gain.setValueAtTime(eq.high || 0, ctx.currentTime);

    // コンプレッサーのバイパス切り替え
    if (clip.compressorEnabled && !nodes.isCompConnected) {
      nodes.highFilter.disconnect();
      nodes.highFilter.connect(nodes.compressor);
      nodes.compressor.connect(nodes.gain);
      nodes.isCompConnected = true;
    } else if (!clip.compressorEnabled && nodes.isCompConnected) {
      nodes.highFilter.disconnect();
      nodes.compressor.disconnect();
      nodes.highFilter.connect(nodes.gain);
      nodes.isCompConnected = false;
    }
  }
  updateVolume() {
    const { video, bgm, pitch, isMuted } = this.state.volume;
    const playbackRate = Math.max(0.25, Math.min(4.0, pitch || 1.0));

    this.state.tracks.forEach(t => {
      if ((t.type === 'video' || t.type === 'audio') && t.element) {
        const el = t.element;

        // 音声分離済みの動画は常に消音を維持
        if (t.type === 'video' && t.isAudioSeparated) {
          if (!el.muted) el.muted = true;
          if (el.volume !== 0) el.volume = 0;
        } else {
          const trkIdx = t.trackIndex || 0;
          const isTrackMuted = !!this.state.trackStates[trkIdx]?.muted;
          const isClipMuted = t.customVolume === 0 || !!t.isAudioMuted;
          const targetMuted = isTrackMuted || isClipMuted;
          if (el.muted !== targetMuted) el.muted = targetMuted;

          const customGain = isClipMuted ? 0 : (t.customVolume !== undefined ? t.customVolume : 1.0);
          const baseVol = t.type === 'video' ? video : bgm;
          const targetVol = targetMuted ? 0 : Math.max(0, Math.min(1.0, baseVol * customGain));

          if (Math.abs(el.volume - targetVol) > 0.001) {
            el.volume = targetVol;
          }
        }

        // 再生速度（ピッチ）の差分更新
        if (el.preservesPitch !== false) el.preservesPitch = false;
        if ('webkitPreservesPitch' in el && el.webkitPreservesPitch !== false) el.webkitPreservesPitch = false;
        if ('mozPreservesPitch' in el && el.mozPreservesPitch !== false) el.mozPreservesPitch = false;

        if (Math.abs(el.playbackRate - playbackRate) > 0.001) {
          el.playbackRate = playbackRate;
        }
      }
    });
  }

  renderLoop(nowTimestamp) {
    if (this.state.isPlaying) {
      // 高精度タイマーでタイムライン時間を進行
      const elapsedSec = (nowTimestamp - this.lastPlayTimestamp) / 1000;
      this.state.currentTime = this.playStartVideoTime + elapsedSec;

      const pitch = this.state.volume.pitch || 1.0;

      // 全動画・音声の再生状態を最小負荷で同期（インデックスループ化・API呼び出し最小化）
      const tracks = this.state.tracks;
      const curTime = this.state.currentTime;

      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (!t._isDisposed && (t.type === 'video' || t.type === 'audio') && t.element && !t.hidden) {
          const el = t.element;
          const inRange = curTime >= t.startTime && curTime < (t.startTime + t.duration);

          if (inRange) {
            const offset = t.mediaOffset || 0;
            const expectedTime = offset + ((curTime - t.startTime) * pitch);
            const mediaDuration = el.duration || Infinity;
            const maxSafeMediaTime = isFinite(mediaDuration) ? Math.max(0, mediaDuration - 0.05) : expectedTime;
            const targetMediaTime = Math.max(0, Math.min(expectedTime, maxSafeMediaTime));

            // 高精度AV同期: 微小なズレは再生速度を微調整して滑らかに追いつかせ、大きなズレのみシーク
            const drift = el.currentTime - targetMediaTime;
            const absDrift = Math.abs(drift);

            // ★ 実尺の終端に達している場合はシークを連打せずそのまま静止
            const isAtEnd = isFinite(mediaDuration) && expectedTime >= maxSafeMediaTime && Math.abs(el.currentTime - maxSafeMediaTime) < 0.1;

            if (!el.seeking && !isAtEnd) {
              if (absDrift > 0.20) {
                // 0.20秒以上の大きなズレは強制シークで復旧
                el.currentTime = targetMediaTime;
                el.playbackRate = pitch;
              } else if (absDrift > 0.04) {
                // 0.04〜0.20秒の軽微なズレは再生レートを ±5% 微調整してスムーズに同期
                const driftCorrection = drift > 0 ? 0.95 : 1.05;
                el.playbackRate = pitch * driftCorrection;
              } else {
                // 正常同期範囲内なら指定のピッチ速度を維持
                if (el.playbackRate !== pitch) {
                  el.playbackRate = pitch;
                }
              }
            }

            // 音声フェードの計算
            const relT = curTime - t.startTime;
            let fadeGain = 1.0;
            const fadeInDur = t.audioFadeIn || 0;
            const fadeOutDur = t.audioFadeOut || 0;

            if (fadeInDur > 0 && relT < fadeInDur) {
              fadeGain *= (relT / fadeInDur);
            }
            if (fadeOutDur > 0 && (t.duration - relT) < fadeOutDur) {
              fadeGain *= ((t.duration - relT) / fadeOutDur);
            }

            if (!t.isAudioSeparated && !this.state.volume.isMuted) {
              const baseVol = t.type === 'video' ? this.state.volume.video : this.state.volume.bgm;
              const customGain = t.customVolume !== undefined ? t.customVolume : 1.0;
              const targetVol = Math.max(0, Math.min(1.0, baseVol * customGain * fadeGain));
              if (Math.abs(el.volume - targetVol) > 0.005) {
                el.volume = targetVol;
              }
            }

            if (el.paused && !t._isPlaying) {
              t._isPlaying = true;
              const playPromise = el.play();
              if (playPromise !== undefined) {
                playPromise.catch(() => {}).finally(() => { t._isPlaying = !el.paused; });
              }
            }
          } else {
            if (!el.paused) {
              t._isPlaying = false;
              try { el.pause(); } catch (e) {}
            }
            // ドリフト微調整後の再生レートを元のピッチ設定値にリセット
            if (el.playbackRate !== pitch) {
              el.playbackRate = pitch;
            }
          }
        }
      }

      if (this.state.currentTime >= this.state.duration) {
        // ★ 終端に達したらタイムライン末尾にピタッとクランプして停止
        this.state.currentTime = this.state.duration;
        this.pause();
        this.seekTo(this.state.duration, true);
      } else {
        this.updateTimelineUIOnly();
      }
      this.isNeedsRender = true;
    }

    if (this.isNeedsRender) {
      this.isNeedsRender = false;

      // キャンバス全体の最下層描画
      this.ctx.fillStyle = this.state.bgColor || '#000000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

      if (this.state.bgMedia && this.state.bgMedia.element) {
        const bgEl = this.state.bgMedia.element;
        // 背景動画の再生・一時停止同期
        if (this.state.bgMedia.type === 'video') {
          if (this.state.isPlaying && bgEl.paused) bgEl.play().catch(() => {});
          else if (!this.state.isPlaying && !bgEl.paused) bgEl.pause();
        }
        const bgW = bgEl.videoWidth || bgEl.naturalWidth || this.canvas.width;
        const bgH = bgEl.videoHeight || bgEl.naturalHeight || this.canvas.height;
        const scale = Math.max(this.canvas.width / bgW, this.canvas.height / bgH);
        const dw = bgW * scale;
        const dh = bgH * scale;
        const dx = (this.canvas.width - dw) / 2;
        const dy = (this.canvas.height - dh) / 2;
        this.ctx.drawImage(bgEl, dx, dy, dw, dh);
      }

      // 現在の時間に該当する全素材を取得（固定配列バッファを再利用してGC負荷を排除）
      if (!this._activeClipsBuffer) {
        this._activeClipsBuffer = [];
      }
      this._activeClipsBuffer.length = 0;

      const curT = this.state.currentTime;
      for (let i = 0; i < this.state.tracks.length; i++) {
        const c = this.state.tracks[i];
        const trkIdx = c.trackIndex || 0;
        const isTrackHidden = !!this.state.trackStates[trkIdx]?.hidden;

        // ★ クリップ個別hidden または トラック全体hidden の場合は描画対象から除外
        if (!c.hidden && !isTrackHidden && curT >= c.startTime && curT <= c.startTime + c.duration) {
          this._activeClipsBuffer.push(c);
        }
        if (c.type === '3d' && c.model) {
          c.model.visible = false;
        }
      }

      // レイヤー重なり順: タイムライン上段(V1=trackIndex:0)を手前に、下段(V2, V3...)を奥に描画
      // 奥にある大きいtrackIndexから先に描き、小さいtrackIndex(V1)を最前面に重ねる
      this._activeClipsBuffer.sort((a, b) => (b.trackIndex || 0) - (a.trackIndex || 0));
      const activeClips = this._activeClipsBuffer;

      // 全3Dモデルを一旦非表示にして準備（各ハンドラー内で個別に単独レンダリング）
      for (let i = 0; i < activeClips.length; i++) {
        const c = activeClips[i];
        if (c.type === '3d' && c.model) {
          c.model.visible = false;
        }
      }

      // オフスクリーンキャンバスの準備（クロマキー用の一時作業バッファ）
      if (!this._offscreenCanvas) {
        this._offscreenCanvas = document.createElement('canvas');
        this._offscreenCtx = this._offscreenCanvas.getContext('2d', { willReadFrequently: true });
      }

      // 順番に描画 (バイパスOFF時はフィルターを完全無効化)
      const f = this.state.filters;
      const isFilterBypassed = f.enabled === false;
      const isFilterActive = !isFilterBypassed && VideoEditorEngine.FILTER_SCHEMA.some(s => f[s.key] !== s.default);

      // フィルター文字列のメモ化（パラメータ未変更時はキャッシュ文字列を再利用）
      if (isFilterActive) {
        const filterKey = VideoEditorEngine.FILTER_SCHEMA.map(s => f[s.key]).join('_');
        if (this._cachedFilterKey !== filterKey) {
          this._cachedFilterKey = filterKey;
          this._cachedFilterStr = VideoEditorEngine.FILTER_SCHEMA
            .map(s => `${s.cssFn}(${f[s.key]}${s.unit})`)
            .join(' ');
        }
      } else {
        this._cachedFilterStr = 'none';
        this._cachedFilterKey = 'none';
      }

      // Canvas コンテキストにフィルターを設定
      this.ctx.filter = this._cachedFilterStr;

      // 1. 各アクティブクリップのアニメーション座標を先行計算（ゼロアロケーション）
      const animMap = this._animTransformsMap || (this._animTransformsMap = new Map());
      animMap.clear();

      let hasAnimatedPhysics = false;
      for (let i = 0; i < activeClips.length; i++) {
        const clip = activeClips[i];
        const animT = this.calculateAnimTransform(clip);
        // 描画用の座標バッファをマップに一時保持
        this._animTransformsMap.set(clip.id, animT);
        if (clip.physics?.enabled && clip.physics?.isAnimated) {
          hasAnimatedPhysics = true;
        }
      }

      // 2. アニメーション連動モードの素材がある場合、リアルタイム衝突・押し出しを適用
      if (hasAnimatedPhysics && window.KeyframeEngine?.resolveAnimatedCollisions) {
        window.KeyframeEngine.resolveAnimatedCollisions(
          activeClips,
          this._animTransformsMap,
          (item) => this.getClipDimensions(item, false)
        );
      }

      // 3. 衝突解決済みの座標で各素材を描画
      for (let i = 0; i < activeClips.length; i++) {
        const activeClip = activeClips[i];
        const animT = this._animTransformsMap.get(activeClip.id) || this.calculateAnimTransform(activeClip);

        this.ctx.globalAlpha = animT.opacity !== undefined ? animT.opacity : 1.0;

        // ★ 登録された描画ハンドラーをプラグイン実行
        const handler = this.drawHandlers[activeClip.type];
        if (typeof handler === 'function') {
          handler(this.ctx, activeClip, animT);
        }

        this.ctx.globalAlpha = 1.0;
      }

      // フィルターと透明度を初期状態にリセット
      this.ctx.filter = 'none';
      this.ctx.globalAlpha = 1.0;

      // Wasm 映画風LUTカラーグレーディングの適用
      if (f.enabled !== false && f.lutPreset && f.lutPreset !== 'none' && f.lutIntensity > 0) {
        this.applyFiltersWithWasm(this.ctx, this.canvas.width, this.canvas.height);
      }
    }

    // 再生中または再描画要求がある場合のみループを継続。静止時は完全停止（スリープ）
    if (this.state.isPlaying || this.isNeedsRender) {
      requestAnimationFrame(this.renderLoop.bind(this));
    } else {
      this.isLoopRunning = false;
    }
  }


  applyChromaKey(ctx, width, height) {
    if (!this.state.chromaKey.enabled) return;

    const imgData = ctx.getImageData(0, 0, width, height);
    const { targetColor, tolerance, smoothness } = this.state.chromaKey;

    let isAppliedByWasm = false;

    // ★ Rust (Wasm) が利用可能な場合は Rust 側で超高速ゼロコピー演算
    if (this.wasmCore && this.wasmCore.apply_chroma_key) {
      try {
        const uint8View = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength);
        this.wasmCore.apply_chroma_key(
          uint8View,
          targetColor.r,
          targetColor.g,
          targetColor.b,
          tolerance,
          smoothness
        );
        isAppliedByWasm = true;
      } catch (wasmErr) {
        console.warn("Wasm クロマキー処理に失敗したため JS にフォールバックします:", wasmErr);
      }
    }

    if (!isAppliedByWasm) {
      // JS フォールバック (緑カブリ低減 Despill 搭載)
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const dist = Math.hypot(r - targetColor.r, g - targetColor.g, b - targetColor.b);
        if (dist <= tolerance) {
          data[i + 3] = 0;
        } else if (smoothness > 0 && dist <= tolerance + smoothness) {
          const alphaRatio = (dist - tolerance) / smoothness;
          data[i + 3] = Math.min(data[i + 3], Math.floor(alphaRatio * 255));

          // ★ 緑カブリ（スピル）を赤と青の平均値以下に抑えて自然なフチにする
          if (targetColor.g > targetColor.r && targetColor.g > targetColor.b) {
            const maxAllowedGreen = (r + b) / 2;
            if (data[i + 1] > maxAllowedGreen) {
              data[i + 1] = maxAllowedGreen;
            }
          }
        }
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  // ★ 映画風 3D-LUT シネマカラーグレーディング（Wasm 高速演算 & JS フォールバック両対応版）
  applyFiltersWithWasm(ctx, width, height) {
    const f = this.state.filters;
    const isLutActive = f.enabled !== false && f.lutPreset && f.lutPreset !== 'none' && f.lutIntensity > 0;
    if (!isLutActive) return false;

    try {
      const imgData = ctx.getImageData(0, 0, width, height);
      let isAppliedByWasm = false;

      // 1. Rust (WebAssembly) による高速演算
      if (this.wasmCore) {
        const uint8View = new Uint8Array(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength);
        if (f.lutPreset === 'custom_cube' && this._customLutData && this.wasmCore.apply_custom_3d_lut) {
          try {
            this.wasmCore.apply_custom_3d_lut(
              uint8View,
              this._customLutData.table,
              this._customLutData.size,
              f.lutIntensity
            );
            isAppliedByWasm = true;
          } catch (e) {
            isAppliedByWasm = false;
          }
        } else if (this.wasmCore.apply_cinematic_lut) {
          try {
            this.wasmCore.apply_cinematic_lut(uint8View, f.lutPreset, f.lutIntensity);
            isAppliedByWasm = true;
          } catch (wasmErr) {
            isAppliedByWasm = false;
          }
        }
      }

      // 2. JavaScript フォールバック演算（Wasm 非稼働時でも確実に発色）
      if (!isAppliedByWasm) {
        const data = imgData.data;
        const factor = Math.max(0, Math.min(1.0, f.lutIntensity));
        const preset = f.lutPreset;

        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          let tr = r, tg = g, tb = b;

          if (preset === 'custom_cube' && this._customLutData) {
            const lut = this._customLutData;
            const s = lut.size;
            const maxIdx = s - 1;

            const rIdx = Math.min(maxIdx, Math.floor((r / 255) * maxIdx));
            const gIdx = Math.min(maxIdx, Math.floor((g / 255) * maxIdx));
            const bIdx = Math.min(maxIdx, Math.floor((b / 255) * maxIdx));

            const tableIdx = (bIdx * s * s + gIdx * s + rIdx) * 3;
            tr = lut.table[tableIdx] * 255;
            tg = lut.table[tableIdx + 1] * 255;
            tb = lut.table[tableIdx + 2] * 255;
          } else if (preset === 'underwater') {
            // ★ 水中・深海: 赤光の大幅減衰＋シアン・ブルー・エメラルドの増幅
            tr = r * 0.35;
            tg = g * 1.15 + 15;
            tb = b * 1.45 + 30;
          } else if (preset === 'golden_hour') {
            // ★ 夕暮れ・ゴールデン: 赤・黄・アンバーの温かい強調
            tr = r * 1.25 + 20;
            tg = g * 1.05 + 10;
            tb = b * 0.75 - 10;
          } else if (preset === 'teal_orange') {
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            if (lum < 128) {
              tr = r * 0.85; tg = g * 1.05; tb = b * 1.25;
            } else {
              tr = r * 1.20; tg = g * 1.02; tb = b * 0.80;
            }
          } else if (preset === 'cyberpunk') {
            tr = r * 1.15 + 15; tg = g * 0.85; tb = b * 1.30 + 20;
          } else if (preset === 'matrix') {
            // ★ SFマトリックス: グリーンティント＋コントラスト
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            tr = lum * 0.65;
            tg = lum * 1.35 + 15;
            tb = lum * 0.75;
          } else if (preset === 'bleach_bypass') {
            // ★ 銀残し: 低彩度＋ハイコントラスト
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            tr = (r * 0.5 + lum * 0.5) * 1.15 - 15;
            tg = (g * 0.5 + lum * 0.5) * 1.15 - 15;
            tb = (b * 0.5 + lum * 0.5) * 1.15 - 15;
          } else if (preset === 'vintage') {
            tr = r * 1.10 + 10; tg = g * 0.95 + 5; tb = b * 0.80 + 15;
          } else if (preset === 'noir') {
            // ★ フィルムノワール: 高コントラスト映画用モノクロ
            const gray = (0.299 * r + 0.587 * g + 0.114 * b);
            const highContrast = gray < 128 ? Math.pow(gray / 128, 1.4) * 128 : 255 - Math.pow((255 - gray) / 128, 1.4) * 128;
            tr = highContrast;
            tg = highContrast;
            tb = highContrast;
          }

          data[i] = Math.max(0, Math.min(255, r + (tr - r) * factor));
          data[i + 1] = Math.max(0, Math.min(255, g + (tg - g) * factor));
          data[i + 2] = Math.max(0, Math.min(255, b + (tb - b) * factor));
        }
      }

      ctx.putImageData(imgData, 0, 0);
      return true;
    } catch (err) {
      console.warn("LUTフィルター処理エラー:", err);
      return false;
    }
  }

  updateExportEstimates() {
    const duration = this.state.duration || 10;
    const format = document.getElementById('export-format')?.value || 'mp4';
    const fps = parseInt(document.getElementById('export-fps')?.value) || 30;
    const quality = document.getElementById('export-quality')?.value || 'high';

    const estimates = window.ExportEngine.constructor.calculateEstimates(
      duration, this.canvas.width, this.canvas.height, format, fps, quality
    );

    const setEl = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };
    setEl('exp-preview-duration', estimates.durationText);
    setEl('exp-preview-size', estimates.sizeText);
    setEl('exp-preview-time', estimates.timeText);
  }

  // 単独フレーム描画（エクスポート・ループ共通）
  renderFrame(targetTime) {
    this.state.currentTime = targetTime;

    this.ctx.fillStyle = this.state.bgColor || '#000000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (this.state.bgMedia && this.state.bgMedia.element) {
      const bgEl = this.state.bgMedia.element;
      const bgW = bgEl.videoWidth || bgEl.naturalWidth || this.canvas.width;
      const bgH = bgEl.videoHeight || bgEl.naturalHeight || this.canvas.height;
      const scale = Math.max(this.canvas.width / bgW, this.canvas.height / bgH);
      const dw = bgW * scale;
      const dh = bgH * scale;
      const dx = (this.canvas.width - dw) / 2;
      const dy = (this.canvas.height - dh) / 2;
      this.ctx.drawImage(bgEl, dx, dy, dw, dh);
    }

    const activeClips = [];
    for (let i = 0; i < this.state.tracks.length; i++) {
      const c = this.state.tracks[i];
      const trkIdx = c.trackIndex || 0;
      const isTrackHidden = !!this.state.trackStates[trkIdx]?.hidden;
      if (!c.hidden && !isTrackHidden && targetTime >= c.startTime && targetTime <= c.startTime + c.duration) {
        activeClips.push(c);
      }
      if (c.type === '3d' && c.model) {
        c.model.visible = false;
      }
    }

    activeClips.sort((a, b) => (b.trackIndex || 0) - (a.trackIndex || 0));

    const f = this.state.filters;
    const isFilterBypassed = f.enabled === false;
    const isFilterActive = !isFilterBypassed && VideoEditorEngine.FILTER_SCHEMA.some(s => f[s.key] !== s.default);

    if (isFilterActive) {
      this.ctx.filter = VideoEditorEngine.FILTER_SCHEMA
        .map(s => `${s.cssFn}(${f[s.key]}${s.unit})`)
        .join(' ');
    } else {
      this.ctx.filter = 'none';
    }

    for (let i = 0; i < activeClips.length; i++) {
      const activeClip = activeClips[i];
      const animT = this.calculateAnimTransform(activeClip);
      this.ctx.globalAlpha = animT.opacity !== undefined ? animT.opacity : 1.0;
      const handler = this.drawHandlers[activeClip.type];
      if (typeof handler === 'function') {
        handler(this.ctx, activeClip, animT);
      }
      this.ctx.globalAlpha = 1.0;
    }

    this.ctx.filter = 'none';
    this.ctx.globalAlpha = 1.0;

    if (f.enabled !== false && f.lutPreset && f.lutPreset !== 'none' && f.lutIntensity > 0) {
      this.applyFiltersWithWasm(this.ctx, this.canvas.width, this.canvas.height);
    }
  }

  // ★ ExportEngine へのオフラインエクスポート委譲（スリム化）
  async exportVideo() {
    this.showLoading("映像キャプチャ準備中...");
    this.pause();
    this.seekTo(0, true);
    await new Promise(r => setTimeout(r, 200));

    const exportFps = parseInt(document.getElementById('export-fps')?.value) || 30;
    const format = document.getElementById('export-format')?.value || 'mp4';
    const filename = document.getElementById('export-filename')?.value.trim() || 'my-video';
    const originalTime = this.state.currentTime;

    try {
      await window.ExportEngine.exportOfflineFrames(
        this.canvas,
        this.state.tracks,
        this.state.duration,
        { fps: exportFps, format, filename },
        {
          audioCtx: this.getAudioContext(),
          onProgress: (msg) => this.showLoading(msg)
        },
        (time) => {
          this.renderFrame(time);
        }
      );
    } catch (e) {
      alert("書き出し失敗: " + e.message);
    } finally {
      this.seekTo(originalTime, true);
      this.updateVolume();
      this.hideLoading();
    }
  }

  togglePlay() { this.state.isPlaying ? this.pause() : this.play(); }

  play() {
    // AudioContext の復帰を保証
    this.getAudioContext();

    // ★ タイムライン末尾にいる場合は自動で先頭(0秒)に戻してから再生開始
    if (this.state.currentTime >= this.state.duration - 0.05) {
      this.state.currentTime = 0;
      this.seekTo(0, true);
    }

    this.state.isPlaying = true;
    this.playBtn.innerText = 'PAUSE';
    this.playBtn.style.fontSize = '9px';

    // 高精度タイムスタンプの基準点を記録
    this.lastPlayTimestamp = performance.now();
    this.playStartVideoTime = this.state.currentTime;

    this.seekTo(this.state.currentTime, true);
    this.updateVolume();

    // 再生開始時に、現在範囲内にあるメディアのみ再生
    this.state.tracks.forEach(t => {
      if ((t.type === 'video' || t.type === 'audio') && t.element) {
        const inRange = this.state.currentTime >= t.startTime && this.state.currentTime < (t.startTime + t.duration);
        if (inRange) {
          const offset = t.mediaOffset || 0;
          t.element.currentTime = (offset + (this.state.currentTime - t.startTime)) * (this.state.volume.pitch || 1.0);
          t.element.play().catch(err => console.log("再生許可待ち:", err));
        } else {
          t.element.pause();
        }
      }
    });

    this.requestRender();
  }

  pause() {
    this.state.isPlaying = false;
    this.playBtn.innerText = 'PLAY';
    this.playBtn.style.fontSize = '9px';

    // タイムライン上のすべての動画・音声を強制停止
    this.state.tracks.forEach(t => {
      if (t.element && typeof t.element.pause === 'function') {
        t.element.pause();
      }
      if (t.innerMediaElement && typeof t.innerMediaElement.pause === 'function') {
        t.innerMediaElement.pause();
      }
    });

    // 背景動画も強制停止
    if (this.state.bgMedia && this.state.bgMedia.element && typeof this.state.bgMedia.element.pause === 'function') {
      this.state.bgMedia.element.pause();
    }

    this.requestRender();
  }

  updateTimeDisplay() {
    const t = Math.max(0, this.state.currentTime);
    const timeKey = (t * 100) | 0; // 高速ビット演算による整数化
    if (this._lastTimeKey === timeKey) return;
    this._lastTimeKey = timeKey;

    const totalSec = (t) | 0;
    const hours = (totalSec / 3600) | 0;
    const m = String(((totalSec % 3600) / 60) | 0).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    const ms = String(((t % 1) * 100) | 0).padStart(2, '0');
    const formatted = hours > 0 ? `${hours}:${m}:${s}.${ms}` : `${m}:${s}.${ms}`;

    if (this._lastFormattedTime !== formatted) {
      this._lastFormattedTime = formatted;
      if (this.timeInput && document.activeElement !== this.timeInput) {
        this.timeInput.value = formatted;
      }
    }
  }

  enableControls() {
    this.playBtn.disabled = false;
    document.getElementById('export-btn').disabled = false;
    document.querySelectorAll('.tool-btn').forEach(b => b.disabled = false);
  }

  showLoading(message = "処理中...") {
    const overlay = document.getElementById('loading-overlay');
    const text = document.getElementById('loading-text');
    if (text) text.innerText = message;
    if (overlay) overlay.classList.remove('hidden');
    this.pause();
  }

  hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  // タイムラインのデータをスクリプトテキストに変換してパネルを開く
  openScriptEditor() {
    const textarea = document.getElementById('timeline-script-textarea');
    if (!textarea) return;

    textarea.value = window.ScriptDSL.exportToScript(this.state.tracks, this.state.markers || []);
    this.toggleSubPanel('panel-script-editor');
  }

  // スクリプトテキストを解析してタイムラインに一括反映（完全同期版）
  applyScriptToTimeline() {
    const textarea = document.getElementById('timeline-script-textarea');
    if (!textarea || !window.ScriptDSL) return;

    this.saveState();
    const { newTracks, newMarkers, errorCount } = window.ScriptDSL.buildTracksFromScript(
      textarea.value,
      this.state.tracks,
      this.threeEngine,
      this.synthEngine
    );

    // 削除対象となる古い素材のリソースを完全解放
    const newTrackIds = new Set(newTracks.map(t => String(t.id)));
    for (let i = 0; i < this.state.tracks.length; i++) {
      const oldClip = this.state.tracks[i];
      if (!newTrackIds.has(String(oldClip.id))) {
        this.disposeClip(oldClip);
      }
    }

    this.state.tracks = newTracks;
    if (newMarkers.length > 0) this.state.markers = newMarkers;
    this.selectedItems = [];

    this.toggleSubPanel('panel-script-editor');
    this.pause();
    this.notifyUpdate();
    this.seekTo(0, true);

    if (errorCount > 0) {
      alert(`台本を反映しました (${errorCount}行の書式不正はスキップされました)`);
    }
  }

  // マーカー打刻処理
  addPointerMarker() {
    this.saveState();
    const curTime = Math.round(this.state.currentTime * 100) / 100;
    const item = this.selectedItem;

    if (item) {
      // 1. 素材選択中：その素材のローカル時間にマーカーを打刻
      if (!item.markers) item.markers = [];
      const relTime = Math.max(0, Math.round((curTime - item.startTime) * 100) / 100);
      const note = prompt(`素材 [${item.name || item.text || item.type}] の [${relTime}s] にマーカーを設置:\nメモを入力してください`, `マーカー ${item.markers.length + 1}`);
      if (note !== null) {
        item.markers.push({ time: relTime, label: note || 'マーカー', id: 'm-' + Date.now() });
        item.markers.sort((a, b) => a.time - b.time);
      }
    } else {
      // 2. 未選択時：タイムライン全体時間にマーカーを打刻
      if (!this.state.markers) this.state.markers = [];
      const note = prompt(`タイムライン [${curTime}s] にマーカーを設置:\nメモを入力してください`, `編集ポイント ${this.state.markers.length + 1}`);
      if (note !== null) {
        this.state.markers.push({ time: curTime, label: note || '編集ポイント', id: 'm-' + Date.now() });
        this.state.markers.sort((a, b) => a.time - b.time);
      }
    }

    if (navigator.vibrate) navigator.vibrate(20);
    this.renderMarkersListUI();
    this.renderTimeRuler();
    this.setupTimelineUI();
  }

  openMarkersPanel() {
    this.renderMarkersListUI();
    const markerModal = document.getElementById('panel-markers');
    if (markerModal) {
      markerModal.classList.toggle('hidden');
    }
  }

  renderMarkersListUI() {
    const listEl = document.getElementById('markers-list-container');
    if (!listEl) return;
    listEl.innerHTML = '';

    const markers = [
      ...(this.state.markers || []).map(m => ({ ...m, isGlobal: true, targetTime: m.time, title: `[全体] ${m.label}` })),
      ...(this.selectedItem?.markers || []).map(m => ({ ...m, isGlobal: false, targetTime: this.selectedItem.startTime + m.time, title: `[素材] ${m.label}` }))
    ].sort((a, b) => a.targetTime - b.targetTime);

    if (markers.length === 0) {
      listEl.innerHTML = '<span style="font-size:11px; color:var(--text-sub); text-align:center; padding:10px;">マーカーはありません。「M」キーまたはボタンで打刻できます。</span>';
      return;
    }

    markers.forEach(m => {
      const row = document.createElement('div');
      row.className = 'marker-item-row';
      row.innerHTML = `<span>${m.title}</span><span class="marker-time-badge">${m.targetTime.toFixed(2)}s</span><button class="btn btn-secondary btn-del-mini">✕</button>`;

      row.onclick = () => this.seekTo(m.targetTime, true);
      row.querySelector('button').onclick = (e) => {
        e.stopPropagation();
        this.saveState();
        if (m.isGlobal) this.state.markers = this.state.markers.filter(x => x.id !== m.id);
        else if (this.selectedItem?.markers) this.selectedItem.markers = this.selectedItem.markers.filter(x => x.id !== m.id);
        this.renderMarkersListUI();
        this.notifyUpdate({ duration: false, toolbar: false });
      };
      listEl.appendChild(row);
    });
  }

  async startScreenRecording() {
    try {
      const stream = await window.ScreenRecorderEngine.startRecording(
        this.canvas,
        () => this.getAudioContext(),
        (sec) => {
          const m = String(Math.floor(sec / 60)).padStart(2, '0');
          const s = String(sec % 60).padStart(2, '0');
          const timerEl = document.getElementById('record-live-timer');
          if (timerEl) timerEl.innerText = `${m}:${s}`;
        },
        () => this.stopScreenRecording()
      );

      document.getElementById('btn-start-record').classList.add('hidden');
      document.getElementById('btn-stop-record').classList.remove('hidden');
      document.getElementById('record-live-box').classList.remove('hidden');
      const liveVid = document.getElementById('record-live-video');
      liveVid.srcObject = stream;
      liveVid.play().catch(() => {});
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        alert("画面録画の開始に失敗しました: " + err.message);
      }
    }
  }

  async stopScreenRecording() {
    const res = await window.ScreenRecorderEngine.stopRecording();
    const liveVid = document.getElementById('record-live-video');
    if (liveVid) { liveVid.pause(); liveVid.srcObject = null; }

    document.getElementById('btn-start-record')?.classList.remove('hidden');
    document.getElementById('btn-stop-record')?.classList.add('hidden');
    document.getElementById('record-live-box')?.classList.add('hidden');
    document.getElementById('panel-screen-record')?.classList.add('hidden');

    if (res?.file) {
      this.showLoading("録画データをタイムラインへ配置中...");
      await this.loadVideoFile(res.file);
      this.hideLoading();
    }
  }
} // ← クラスの閉じ括弧

window.addEventListener('DOMContentLoaded', () => {
  window.editor = new VideoEditorEngine();
});