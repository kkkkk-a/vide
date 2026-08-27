class AnimationEngine {
  // ★ クラス静的定数として共有（インスタンスごとの配列再生成を排除）
  static presets = {
    in: [
      { id: 'none', label: 'なし' },
      { id: 'charPop', label: '文字単位ポップ (1文字ずつ弾む)' },
      { id: 'charDrop', label: '文字単位ドロップ (1文字ずつ落下)' },
      { id: 'charBounce', label: '文字単位バウンド (連続着地)' },
      { id: 'fadeIn', label: 'フェードイン' },
      { id: 'zoomIn', label: 'ズームイン' },
      { id: 'popUp', label: 'ポップアップ (弾む)' },
      { id: 'bounceIn', label: 'バウンス登場' },
      { id: 'dropIn', label: 'ドロップ (上から落下)' },
      { id: 'slideUp', label: 'スライド (下から)' },
      { id: 'slideLeft', label: 'スライド (左から)' },
      { id: 'slideRightIn', label: 'スライド (右から)' },
      { id: 'flipIn', label: '3Dフリップ回転' },
      { id: 'spinZoom', label: 'スピン拡大登場' },
      { id: 'spinFlip', label: '3Dスピン＆フリップ' },
      { id: 'typewriter', label: 'タイピング (1文字ずつ)' }
    ],
    main: [
      { id: 'none', label: 'なし' },
      { id: 'spin', label: '2D平面回転' },
      { id: 'spin3D', label: '3D自転 (Y軸立体スピン)' },
      { id: 'tumble3D', label: '3D宙返り (無重力3軸回転)' },
      { id: 'orbit3D', label: '3D公転 (手前と奥の周回)' },
      { id: 'drill3D', label: '3Dドリル (超高速スピン)' },
      { id: 'wobble3D', label: '3Dプルプル揺れ' },
      { id: 'float', label: 'ゆらゆら浮遊' },
      { id: 'floatSpin', label: '浮遊＋自転' },
      { id: 'pulse', label: 'パルス (鼓動)' },
      { id: 'heartbeat', label: 'ハートビート (2段脈動)' },
      { id: 'hop', label: 'ジャンプ (跳ねる)' },
      { id: 'shake', label: 'シェイク (振動)' },
      { id: 'glitch', label: 'グリッチ (ブレノイズ)' },
      { id: 'breathe', label: '呼吸 (ブリーズ)' },
      { id: 'swing', label: 'ブランコ揺れ' },
      { id: 'flash', label: '点滅' }
    ],
    out: [
      { id: 'none', label: 'なし' },
      { id: 'fadeOut', label: 'フェードアウト' },
      { id: 'zoomOut', label: 'ズームアウト' },
      { id: 'popOut', label: 'ポップ縮小消滅' },
      { id: 'fallDown', label: '落下退場' },
      { id: 'slideDown', label: 'スライド (下へ)' },
      { id: 'slideRight', label: 'スライド (右へ)' },
      { id: 'slideLeftOut', label: 'スライド (左へ)' },
      { id: 'flipOut', label: '3Dフリップ退場' },
      { id: 'spinZoomOut', label: 'スピン縮小退場' },
      { id: 'shrinkSpin', label: '高速スピン消滅' }
    ]
  };

  constructor() {
    this.presets = AnimationEngine.presets; // 後方互換アクセサ
  }

  calculateTransform(clip, currentTime) {
    const startTime = clip.startTime !== undefined ? clip.startTime : (clip.start !== undefined ? clip.start : 0);
    const duration = clip.duration !== undefined ? clip.duration : (clip.end !== undefined ? clip.end - clip.start : 5);
    const relTime = currentTime - startTime;

    // クリップ内部の再利用バッファを初期化（メモリ確保ゼロ化）
    if (!clip._animResultBuffer) {
      clip._animResultBuffer = { scale: 1, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0, opacity: 1, typewriterProgress: 1.0 };
    }
    const res = clip._animResultBuffer;

    // クリップ表示時間外は完全非表示を即時返却
    if (relTime < 0 || relTime > duration) {
      res.scale = 1; res.rotation = 0; res.rotateX = 0; res.rotateY = 0; res.x = 0; res.y = 0; res.opacity = 0; res.typewriterProgress = 1.0;
      return res;
    }

    const animProps = clip.animProps;
    const hasIn = animProps?.inAnim && animProps.inAnim !== 'none';
    const hasMain = animProps?.mainAnim && animProps.mainAnim !== 'none';
    const hasOut = animProps?.outAnim && animProps.outAnim !== 'none';
    const hasMultiMain = Array.isArray(clip.mainAnimations) && clip.mainAnimations.length > 0;

    const rawT = clip.transform || {};
    res.scale = rawT.scale !== undefined ? rawT.scale : 1;
    res.rotation = rawT.rotation !== undefined ? rawT.rotation : 0;
    res.rotateX = rawT.rotateX !== undefined ? rawT.rotateX : 0;
    res.rotateY = rawT.rotateY !== undefined ? rawT.rotateY : 0;
    res.x = rawT.x !== undefined ? rawT.x : 0;
    res.y = rawT.y !== undefined ? rawT.y : 0;
    res.opacity = rawT.opacity !== undefined ? rawT.opacity : 1.0;
    res.typewriterProgress = 1.0;

    // ① アニメーション未設定の静止クリップは計算を即座にスキップ
    if (!hasIn && !hasMain && !hasOut && !hasMultiMain) {
      return res;
    }

    if (duration <= 0.001) {
      res.opacity = 0;
      return res;
    }

    // ② 同一フレーム（時間未変化）かつパラメータ変更なし時のキャッシュ再利用
    const relTimeSnap = Math.round(relTime * 100) / 100;
    const durSnap = Math.round(duration * 100) / 100;
    const mainAnimsStr = Array.isArray(clip.mainAnimations) && clip.mainAnimations.length > 0
      ? clip.mainAnimations.map(a => `${a.type}_${a.delay}_${a.duration}`).join('|')
      : '';
    const inDurKey = animProps?.inDuration || 0.8;
    const outDurKey = animProps?.outDuration || 0.8;
    const rawOpacity = rawT.opacity !== undefined ? rawT.opacity : 1.0;
    const transformKey = `${durSnap}_${rawT.scale}_${rawT.rotation}_${rawT.rotateX}_${rawT.rotateY}_${rawT.x}_${rawT.y}_${rawOpacity}_${animProps?.inAnim}_${animProps?.mainAnim}_${animProps?.outAnim}_${inDurKey}_${outDurKey}_${mainAnimsStr}`;

    if (clip._cachedRelTime === relTimeSnap && clip._cachedTransformKey === transformKey && clip._cachedTransform) {
      Object.assign(res, clip._cachedTransform);
      return res;
    }

    // ★ 実際に設定されているアニメーションの時間のみを合算してクランプ
    let inDur = hasIn ? Math.max(0.001, animProps?.inDuration || 0.8) : 0;
    let outDur = hasOut ? Math.max(0.001, animProps?.outDuration || 0.8) : 0;
    const totalAnimTime = inDur + outDur;

    if (totalAnimTime > duration && totalAnimTime > 0) {
      const ratio = duration / totalAnimTime;
      inDur *= ratio;
      outDur *= ratio;
    }

    // --- 1. 開始 (In) アニメーション ---
    if (hasIn && relTime < inDur) {
      const p = Math.min(1, Math.max(0, inDur > 0 ? relTime / inDur : 1));
      const ease = this.easeOutCubic(p);
      const popEase = this.easeOutBack(p);

      switch (animProps.inAnim) {
        case 'fadeIn': res.opacity *= ease; break;
        case 'zoomIn': res.scale *= ease; break;
        case 'popUp': res.scale *= Math.max(0, popEase); res.opacity *= ease; break;
        case 'bounceIn': res.scale *= this.easeOutBounce(p); break;
        case 'dropIn': res.y += (1 - this.easeOutBounce(p)) * 600; res.opacity *= ease; break; // ★ 上(+600)から落下
        case 'slideUp': res.y -= (1 - ease) * 400; break; // ★ 下(-400)からスライド登場
        case 'slideLeft': res.x -= (1 - ease) * 400; break;
        case 'slideRightIn': res.x += (1 - ease) * 400; break;
        case 'flipIn': res.rotateY += (1 - ease) * 180; res.opacity *= ease; break;
        case 'spinZoom': res.scale *= ease; res.rotation += (1 - ease) * 720; break;
        case 'spinFlip':
          res.scale *= ease;
          res.rotateX += (1 - ease) * 180;
          res.rotateY += (1 - ease) * 360;
          res.opacity *= ease;
          break;
        case 'typewriter':
          res.typewriterProgress = p; // テキスト描画側で文字数制御
          break;
      }
    }

    // --- 2. 途中効果 (Main) アニメーション ---
    const applyMainEffect = (type, time) => {
      switch (type) {
        case 'zoom':
          res.scale *= (1 + Math.sin(time * 3) * 0.15);
          break;
        case 'float':
          res.y += Math.sin(time * 2.5) * 16;
          break;
        case 'floatSpin':
          res.y += Math.sin(time * 2.5) * 14;
          res.rotation += time * 45;
          break;
        case 'pulse':
          res.scale *= (1 + Math.abs(Math.sin(time * 5)) * 0.12);
          break;
        case 'heartbeat': {
          const beat = (time * 2.5) % 1.0;
          const punch = beat < 0.2 ? Math.sin(beat * Math.PI * 5) * 0.18 : (beat < 0.4 ? Math.sin((beat - 0.2) * Math.PI * 5) * 0.10 : 0);
          res.scale *= (1 + punch);
          break;
        }
        case 'hop':
          res.y += Math.max(0, Math.sin(time * 6) * 30); // ★ 上(+Y方向)へ跳ね上がるように修正
          break;
        case 'spin':
          res.rotation += time * 90;
          break;
        // ★ 3D系アニメーションの計算統合（全素材で立体的に動作）
        case 'spin3D':
          res.rotateY += time * 120; // 3D Y軸スピン
          break;
        case 'tumble3D':
          res.rotateX += time * 90;  // 3軸無重力宙返り
          res.rotateY += time * 135;
          res.rotation += time * 45;
          break;
        case 'orbit3D': {
          const orbitAngle = time * 2.0;
          res.x += Math.sin(orbitAngle) * 120;
          // 手前と奥の移動をスケールとY軸傾きで表現
          res.scale *= (1.0 + Math.cos(orbitAngle) * 0.25);
          res.rotateY += Math.sin(orbitAngle) * 35;
          break;
        }
        case 'drill3D':
          res.rotation += time * 720; // 超高速ドリル回転
          res.rotateX += Math.sin(time * 10) * 15;
          break;
        case 'wobble3D':
          res.rotateX += Math.sin(time * 8.0) * 18;
          res.rotateY += Math.cos(time * 7.0) * 18;
          res.rotation += Math.sin(time * 5.0) * 10;
          break;
        case 'shake':
          res.x += Math.sin(time * 50) * 6 + Math.sin(time * 33) * 4;
          res.y += Math.cos(time * 45) * 6 + Math.cos(time * 27) * 4;
          break;
        case 'glitch':
          if (Math.sin(time * 25) > 0.6) {
            const noiseX = Math.sin(time * 123.45);
            const noiseY = Math.cos(time * 67.89);
            const noiseRot = Math.sin(time * 98.76);
            res.x += noiseX * 12;
            res.y += noiseY * 6;
            res.rotateX += noiseRot * 8;
          }
          break;
        case 'breathe':
          res.scale *= (1 + Math.sin(time * 1.8) * 0.08);
          res.opacity *= (0.85 + Math.sin(time * 1.8) * 0.15);
          break;
        case 'swing':
          res.rotation += Math.sin(time * 3) * 15;
          break;
        case 'flash':
          res.opacity *= (0.4 + Math.abs(Math.sin(time * 6)) * 0.6);
          break;
      }
    };

    if (hasMain) {
      applyMainEffect(animProps.mainAnim, relTime);
    }

    if (hasMultiMain) {
      clip.mainAnimations.forEach(anim => {
        if (!anim || !anim.type) return;
        const delay = typeof anim.delay === 'number' ? anim.delay : 0;
        const animDuration = typeof anim.duration === 'number' ? anim.duration : 0;

        if (relTime >= delay) {
          const animRelTime = relTime - delay;
          if (animDuration === 0 || animRelTime <= animDuration) {
            applyMainEffect(anim.type, animRelTime);
          }
        }
      });
    }

    // --- 3. 終了 (Out) アニメーション ---
    if (hasOut) {
      const remainTime = duration - relTime;
      if (remainTime < outDur) {
        const p = Math.min(1, Math.max(0, remainTime / outDur));
        const ease = this.easeInCubic(p);

        switch (animProps.outAnim) {
          case 'fadeOut': res.opacity *= ease; break;
          case 'zoomOut': res.scale *= ease; break;
          case 'popOut':
            res.scale *= (1 + (1 - ease) * 0.3) * ease;
            res.opacity *= ease;
            break;
          case 'fallDown':
            res.y -= (1 - ease) * 600; // ★ 下(-600)へ落下退場
            res.rotation += (1 - ease) * 35;
            res.opacity *= ease;
            break;
          case 'slideDown': res.y -= (1 - ease) * 400; break; // ★ 下(-400)へスライド退場
          case 'slideRight': res.x += (1 - ease) * 400; break;
          case 'slideLeftOut': res.x -= (1 - ease) * 400; break;
          case 'flipOut': res.rotateY += (1 - ease) * 180; res.opacity *= ease; break;
          case 'spinZoomOut': res.scale *= ease; res.rotation += (1 - ease) * 720; break;
          case 'shrinkSpin':
            res.scale *= ease;
            res.rotation += (1 - ease) * 1080;
            res.opacity *= ease;
            break;
        }
      }
    }

    // ★ 重複エフェクトによる極端な破綻（巨大化・完全透明化）を安全ガード
    res.scale = Math.max(0.001, Math.min(10.0, res.scale));
    res.opacity = Math.max(0.0, Math.min(1.0, res.opacity));

    // 結果をシャローコピーしてキャッシュ（バッファの次回更新による汚染を防止）
    clip._cachedRelTime = relTimeSnap;
    clip._cachedTransformKey = transformKey;
    clip._cachedTransform = { ...res };

    // ★ 新規オブジェクトを作らず、バッファ res をそのまま返却（GC負荷ゼロ）
    return res;
  }
  // イージング関数
  easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
  easeInCubic(t) { return t * t * t; }
  easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }
  easeOutBounce(t) {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) {
      return n1 * t * t;
    } else if (t < 2 / d1) {
      const p = t - 1.5 / d1;
      return n1 * p * p + 0.75;
    } else if (t < 2.5 / d1) {
      const p = t - 2.25 / d1;
      return n1 * p * p + 0.9375;
    } else {
      const p = t - 2.625 / d1;
      return n1 * p * p + 0.984375;
    }
  }

  /**
   * 2つの連続するクリップ間にトランジション（つなぎ目効果）を設定
   * @param {Object} clipA - 前のクリップ
   * @param {Object} clipB - 後ろのクリップ
   * @param {string} type - トランジション種別
   * @param {number} duration - 効果秒数
   */
  applyTransition(clipA, clipB, type, duration = 0.6) {
    if (!clipA.animProps) clipA.animProps = { inAnim: 'none', mainAnim: 'none', outAnim: 'none' };
    if (!clipB.animProps) clipB.animProps = { inAnim: 'none', mainAnim: 'none', outAnim: 'none' };

    clipA.animProps.outDuration = duration;
    clipB.animProps.inDuration = duration;

    if (type === 'none') {
      clipA.animProps.outAnim = 'none';
      clipB.animProps.inAnim = 'none';
    } else if (type === 'crossfade' || type === 'fadeblack') {
      clipA.animProps.outAnim = 'fadeOut';
      clipB.animProps.inAnim = 'fadeIn';
    } else if (type === 'slideLeft') {
      clipA.animProps.outAnim = 'none';
      clipB.animProps.inAnim = 'slideLeft';
    } else if (type === 'zoom') {
      clipA.animProps.outAnim = 'zoomOut';
      clipB.animProps.inAnim = 'zoomIn';
    } else if (type === 'flip') {
      clipA.animProps.outAnim = 'flipOut';
      clipB.animProps.inAnim = 'flipIn';
    } else if (type === 'spin') {
      clipA.animProps.outAnim = 'spinZoomOut';
      clipB.animProps.inAnim = 'spinZoom';
    }
  }
}

window.AnimationEngine = new AnimationEngine();