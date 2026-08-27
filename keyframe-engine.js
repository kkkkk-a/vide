/**
 * KeyframeEngine - 汎用キーフレーム補間エンジン
 * 位置 (X, Y), 拡大率 (Scale), 回転 (Rotation), 不透明度 (Opacity) の自由アニメーション
 */
class KeyframeEngine {
  // 速度カーブプリセット定義
  static EASING_PRESETS = [
    { id: 'easeInOut', label: 'イーズインアウト (滑らか・標準)' },
    { id: 'easeOut',   label: 'イーズアウト (減速して停止)' },
    { id: 'easeIn',    label: 'イーズイン (徐々に加速)' },
    { id: 'linear',    label: 'リニア (等速直線運動)' },
    { id: 'back',      label: 'バック (行き過ぎてピタッと戻る)' },
    { id: 'bounce',    label: 'バウンス (着地バウンド)' }
  ];

  static applyEasing(t, type = 'easeInOut') {
    switch (type) {
      case 'linear':
        return t;
      case 'easeIn':
        return t * t * t;
      case 'easeOut':
        return 1 - Math.pow(1 - t, 3);
      case 'back': {
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
      }
      case 'bounce': {
        const n1 = 7.5625, d1 = 2.75;
        if (t < 1 / d1) return n1 * t * t;
        else if (t < 2 / d1) { const p = t - 1.5 / d1; return n1 * p * p + 0.75; }
        else if (t < 2.5 / d1) { const p = t - 2.25 / d1; return n1 * p * p + 0.9375; }
        else { const p = t - 2.625 / d1; return n1 * p * p + 0.984375; }
      }
      case 'easeInOut':
      default:
        return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }
  }

  constructor() {
    // 補間対象のプロパティ一覧
    this.supportedProps = ['x', 'y', 'scale', 'rotation', 'opacity'];
  }

  /**
   * 現在時刻におけるプロパティ値をキーフレーム補間して算出 (ゼロアロケーション / GCゼロ)
   * @param {Object} clip - 対象クリップ
   * @param {number} currentTime - 全体タイムライン時間
   * @returns {Object} 補間後の transform オブジェクト (再利用バッファ)
   */
  evaluate(clip, currentTime) {
    if (!clip._kfResultBuffer) {
      clip._kfResultBuffer = { x: 0, y: 0, scale: 1.0, rotation: 0, rotateX: 0, rotateY: 0, opacity: 1.0 };
    }
    const res = clip._kfResultBuffer;

    const t = clip.transform || {};
    res.x = t.x || 0;
    res.y = t.y || 0;
    res.scale = t.scale !== undefined ? t.scale : 1.0;
    res.rotation = t.rotation || 0;
    res.rotateX = t.rotateX || 0;
    res.rotateY = t.rotateY || 0;
    res.opacity = t.opacity !== undefined ? t.opacity : 1.0;

    const kfs = clip.keyframes;
    if (!kfs || kfs.length === 0) {
      return res;
    }

    const relTime = Math.max(0, currentTime - clip.startTime);
    const len = kfs.length;

    // 1. 単一キーフレームまたは範囲外（定数時間 O(1)）
    if (len === 1 || relTime <= kfs[0].time) {
      const p = kfs[0].props;
      if (p.x !== undefined) res.x = p.x;
      if (p.y !== undefined) res.y = p.y;
      if (p.scale !== undefined) res.scale = p.scale;
      if (p.rotation !== undefined) res.rotation = p.rotation;
      if (p.opacity !== undefined) res.opacity = p.opacity;
      return res;
    }

    if (relTime >= kfs[len - 1].time) {
      const p = kfs[len - 1].props;
      if (p.x !== undefined) res.x = p.x;
      if (p.y !== undefined) res.y = p.y;
      if (p.scale !== undefined) res.scale = p.scale;
      if (p.rotation !== undefined) res.rotation = p.rotation;
      if (p.opacity !== undefined) res.opacity = p.opacity;
      return res;
    }

    // 2. 二分探索（Binary Search）による高速な前後フレーム特定 O(log N)
    let low = 0;
    let high = len - 1;
    let idx = 0;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (kfs[mid].time <= relTime) {
        idx = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const nextIdx = Math.min(len - 1, idx + 1);
    const prevKf = kfs[idx];
    const nextKf = kfs[nextIdx];

    const timeSpan = nextKf.time - prevKf.time;
    const rawProgress = timeSpan > 0.0001 ? (relTime - prevKf.time) / timeSpan : 0;
    const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(1, rawProgress)) : 0;
    const easingType = nextKf.easing || prevKf.easing || 'easeInOut';
    const ease = KeyframeEngine.applyEasing(progress, easingType);

    // 3. 各プロパティの補間を直接バッファに代入
    const p1 = prevKf.props;
    const p2 = nextKf.props;

    const x1 = p1.x !== undefined ? p1.x : res.x;
    const x2 = p2.x !== undefined ? p2.x : res.x;
    res.x = x1 + (x2 - x1) * ease;

    const y1 = p1.y !== undefined ? p1.y : res.y;
    const y2 = p2.y !== undefined ? p2.y : res.y;
    res.y = y1 + (y2 - y1) * ease;

    const s1 = p1.scale !== undefined ? p1.scale : res.scale;
    const s2 = p2.scale !== undefined ? p2.scale : res.scale;
    res.scale = s1 + (s2 - s1) * ease;

    const r1 = p1.rotation !== undefined ? p1.rotation : res.rotation;
    const r2 = p2.rotation !== undefined ? p2.rotation : res.rotation;
    res.rotation = r1 + (r2 - r1) * ease;

    const o1 = p1.opacity !== undefined ? p1.opacity : res.opacity;
    const o2 = p2.opacity !== undefined ? p2.opacity : res.opacity;
    res.opacity = o1 + (o2 - o1) * ease;

    return res;
  }

  /**
   * 現在時刻にキーフレームを打刻 / 上書き
   */
  addOrUpdateKeyframe(clip, currentTime) {
    if (!clip.keyframes) clip.keyframes = [];
    const maxDur = isFinite(clip.duration) ? clip.duration : 10;
    const relTime = Math.max(0, Math.min(maxDur, Math.round((currentTime - (clip.startTime || 0)) * 100) / 100));

    const currentProps = {
      x: clip.transform?.x || 0,
      y: clip.transform?.y || 0,
      scale: clip.transform?.scale !== undefined ? clip.transform.scale : 1.0,
      rotation: clip.transform?.rotation || 0,
      rotateX: clip.transform?.rotateX || 0,
      rotateY: clip.transform?.rotateY || 0,
      opacity: clip.transform?.opacity !== undefined ? clip.transform.opacity : 1.0
    };


    const existingIdx = clip.keyframes.findIndex(k => Math.abs(k.time - relTime) < 0.04);
    if (existingIdx !== -1) {
      clip.keyframes[existingIdx].props = currentProps;
    } else {
      clip.keyframes.push({
        id: 'kf-' + Date.now(),
        time: relTime,
        easing: 'easeInOut',
        props: currentProps
      });
      clip.keyframes.sort((a, b) => a.time - b.time);
    }
  }

  /**
   * 指定したキーフレームを削除
   */
  removeKeyframe(clip, keyframeId) {
    if (!clip.keyframes) return;
    clip.keyframes = clip.keyframes.filter(k => k.id !== keyframeId);
  }

  easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  // ★ アニメーション中のリアルタイム衝突・反発計算（非破壊バッファ演算）
  resolveAnimatedCollisions(activeClips, animTransforms, getRealSizeFn) {
    const len = activeClips.length;
    for (let i = 0; i < len; i++) {
      const a = activeClips[i];
      if (!a.physics?.enabled) continue;
      const transA = animTransforms.get(a.id);
      if (!transA) continue;

      const sizeA = getRealSizeFn(a);
      const aW = Math.max(20, sizeA.w * (transA.scale || 1.0));
      const aH = Math.max(20, sizeA.h * (transA.scale || 1.0));
      const bounceA = a.physics.bounciness ?? 0.4;
      const isStaticA = !!a.physics.isStatic;

      for (let j = i + 1; j < len; j++) {
        const b = activeClips[j];
        if (!b.physics?.enabled) continue;
        const transB = animTransforms.get(b.id);
        if (!transB) continue;

        // 少なくともどちらか一方が「アニメーション連動」または「押し出し」の場合に判定
        if (!a.physics.isAnimated && !b.physics.isAnimated && !a.physics.enabled) continue;

        const sizeB = getRealSizeFn(b);
        const bW = Math.max(20, sizeB.w * (transB.scale || 1.0));
        const bH = Math.max(20, sizeB.h * (transB.scale || 1.0));
        const bounceB = b.physics.bounciness ?? 0.4;
        const isStaticB = !!b.physics.isStatic;

        const overlapX = (aW / 2 + bW / 2) - Math.abs((transA.x || 0) - (transB.x || 0));
        const overlapY = (aH / 2 + bH / 2) - Math.abs((transA.y || 0) - (transB.y || 0));

        if (overlapX > 0 && overlapY > 0) {
          const bounceMult = 1.0 + (bounceA + bounceB) * 0.5;

          // ★ 衝突時の弾力変形（スクワッシュ量: 0.05〜0.15）
          const squish = Math.min(0.15, (overlapX + overlapY) * 0.002 * bounceMult);

          if (overlapX < overlapY) {
            const dirX = (transA.x || 0) < (transB.x || 0) ? 1 : -1;
            const pushX = overlapX * dirX * bounceMult;
            if (!isStaticB && !isStaticA) {
              transB.x = (transB.x || 0) + pushX * 0.5;
              transA.x = (transA.x || 0) - pushX * 0.5;
              if (b.physics.isAnimated) transB.scale = (transB.scale || 1.0) * (1 - squish);
              if (a.physics.isAnimated) transA.scale = (transA.scale || 1.0) * (1 - squish);
            } else if (!isStaticB) {
              transB.x = (transB.x || 0) + pushX;
              if (b.physics.isAnimated) transB.scale = (transB.scale || 1.0) * (1 - squish);
            } else if (!isStaticA) {
              transA.x = (transA.x || 0) - pushX;
              if (a.physics.isAnimated) transA.scale = (transA.scale || 1.0) * (1 - squish);
            }
          } else {
            const dirY = (transA.y || 0) < (transB.y || 0) ? 1 : -1;
            const pushY = overlapY * dirY * bounceMult;
            if (!isStaticB && !isStaticA) {
              transB.y = (transB.y || 0) + pushY * 0.5;
              transA.y = (transA.y || 0) - pushY * 0.5;
              if (b.physics.isAnimated) transB.scale = (transB.scale || 1.0) * (1 - squish);
              if (a.physics.isAnimated) transA.scale = (transA.scale || 1.0) * (1 - squish);
            } else if (!isStaticB) {
              transB.y = (transB.y || 0) + pushY;
              if (b.physics.isAnimated) transB.scale = (transB.scale || 1.0) * (1 - squish);
            } else if (!isStaticA) {
              transA.y = (transA.y || 0) - pushY;
              if (a.physics.isAnimated) transA.scale = (transA.scale || 1.0) * (1 - squish);
            }
          }
        }
      }
    }
  }

  // ★ 1. 二分探索による最近傍スナップ吸着計算
  calculateSnapTime(targetTime, tracks, currentTime = 0, markers = [], currentClipId = null, clipDuration = 0, zoom = 60) {
    const snapThreshold = Math.min(1.5, 12 / Math.max(1, zoom)); // 最大でも1.5秒以上の過剰吸着を防止
    let closestTime = targetTime;
    let minDiff = snapThreshold;
    let snappedPoint = null;

    const points = [0, currentTime || 0];
    markers.forEach(m => points.push(m.time));

    for (let i = 0; i < tracks.length; i++) {
      const c = tracks[i];
      if (c.id !== currentClipId) {
        const s = c.startTime || 0;
        points.push(s, s + (c.duration || 0));
      }
    }

    const sortedPoints = Array.from(new Set(points)).sort((a, b) => a - b);
    const len = sortedPoints.length;

    const findClosest = (val) => {
      let low = 0, high = len - 1;
      let best = sortedPoints[0];
      let diff = Math.abs(val - best);

      while (low <= high) {
        const mid = (low + high) >> 1;
        const cur = sortedPoints[mid];
        const curDiff = Math.abs(val - cur);

        if (curDiff < diff) {
          diff = curDiff;
          best = cur;
        }

        if (cur < val) low = mid + 1;
        else if (cur > val) high = mid - 1;
        else return { point: cur, diff: 0 };
      }
      return { point: best, diff };
    };

    const leftRes = findClosest(targetTime);
    if (leftRes.diff < minDiff) {
      minDiff = leftRes.diff;
      closestTime = leftRes.point;
      snappedPoint = leftRes.point;
    }

    if (clipDuration > 0) {
      const rightRes = findClosest(targetTime + clipDuration);
      if (rightRes.diff < minDiff) {
        closestTime = rightRes.point - clipDuration;
        snappedPoint = rightRes.point;
      }
    }

    return { time: closestTime, snappedPoint };
  }

  // ★ 2. 物理衝突判定・反発計算（確実な押し出し・反発力）
  resolveCollision(activeDrag, activeClips, getRealSizeFn) {
    if (!activeDrag || !activeDrag.physics?.enabled) return;

    const a = activeDrag;
    if (!a.transform) a.transform = { scale: 1, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 };
    const aX = a.transform.x || 0;
    const aY = a.transform.y || 0;
    const sizeA = getRealSizeFn(a);
    const aW = Math.max(20, sizeA.w);
    const aH = Math.max(20, sizeA.h);
    const bouncinessA = a.physics.bounciness ?? 0.4;
    const isStaticA = !!a.physics.isStatic;

    for (let j = 0; j < activeClips.length; j++) {
      const b = activeClips[j];
      if (!b || b === a || !b.physics?.enabled) continue;
      if (!b.transform) b.transform = { scale: 1, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 };

      const bX = b.transform.x || 0;
      const bY = b.transform.y || 0;
      const sizeB = getRealSizeFn(b);
      const bW = Math.max(20, sizeB.w);
      const bH = Math.max(20, sizeB.h);

      // AABB（境界ボックス）交差深度の計算
      const overlapX = (aW / 2 + bW / 2) - Math.abs(aX - bX);
      const overlapY = (aH / 2 + bH / 2) - Math.abs(aY - bY);

      if (overlapX > 0 && overlapY > 0) {
        if (navigator.vibrate) navigator.vibrate(10);

        const bouncinessB = b.physics.bounciness ?? 0.4;
        const bounceMult = 1.0 + (bouncinessA + bouncinessB) * 0.5;
        const isStaticB = !!b.physics.isStatic;

        // 重なりが浅い軸の方向に確実に押し出す（反発率を反映）
        if (overlapX < overlapY) {
          const dirX = aX < bX ? 1 : -1;
          const pushX = overlapX * dirX * bounceMult;
          if (!isStaticB) b.transform.x += pushX;
          else if (!isStaticA) a.transform.x -= pushX;
        } else {
          const dirY = aY < bY ? 1 : -1;
          const pushY = overlapY * dirY * bounceMult;
          if (!isStaticB) b.transform.y += pushY;
          else if (!isStaticA) a.transform.y -= pushY;
        }
      }
    }
  }

  // ★ 3. 多機能整列・均等配置の幾何計算
  alignClips(items, action, mode, canvasWidth, canvasHeight, getDimsFn) {
    if (!items || items.length === 0) return;
    const keyItem = items[0];

    let targetX = 0, targetY = 0;
    let targetLeft = -canvasWidth / 2, targetRight = canvasWidth / 2;
    let targetTop = canvasHeight / 2, targetBottom = -canvasHeight / 2;

    if (mode === 'key' && items.length > 1) {
      targetX = keyItem.transform?.x || 0;
      targetY = keyItem.transform?.y || 0;
      const kd = getDimsFn(keyItem);
      targetLeft = targetX - kd.w / 2;
      targetRight = targetX + kd.w / 2;
      targetTop = targetY + kd.h / 2;
      targetBottom = targetY - kd.h / 2;
    } else if (mode === 'group' && items.length > 1) {
      const bounds = items.map(item => {
        const d = getDimsFn(item);
        const x = item.transform?.x || 0;
        const y = item.transform?.y || 0;
        return { l: x - d.w / 2, r: x + d.w / 2, t: y + d.h / 2, b: y - d.h / 2 };
      });
      targetLeft = Math.min(...bounds.map(b => b.l));
      targetRight = Math.max(...bounds.map(b => b.r));
      targetTop = Math.max(...bounds.map(b => b.t));
      targetBottom = Math.min(...bounds.map(b => b.b));
      targetX = (targetLeft + targetRight) / 2;
      targetY = (targetTop + targetBottom) / 2;
    }

    const targetItems = (mode === 'key' && items.length > 1) ? items.slice(1) : items;

    if (action === 'left') {
      targetItems.forEach(i => { i.transform.x = targetLeft + getDimsFn(i).w / 2; });
    } else if (action === 'hcenter') {
      targetItems.forEach(i => { i.transform.x = targetX; });
    } else if (action === 'right') {
      targetItems.forEach(i => { i.transform.x = targetRight - getDimsFn(i).w / 2; });
    } else if (action === 'top') {
      targetItems.forEach(i => { i.transform.y = targetTop - getDimsFn(i).h / 2; });
    } else if (action === 'vcenter') {
      targetItems.forEach(i => { i.transform.y = targetY; });
    } else if (action === 'bottom') {
      targetItems.forEach(i => { i.transform.y = targetBottom + getDimsFn(i).h / 2; });
    } else if (action === 'distribute-h' && items.length >= 3) {
      const sorted = [...items].sort((a, b) => (a.transform?.x || 0) - (b.transform?.x || 0));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const firstLeft = (first.transform?.x || 0) - (getDimsFn(first).w / 2);
      const lastRight = (last.transform?.x || 0) + (getDimsFn(last).w / 2);
      const totalItemsWidth = sorted.reduce((sum, it) => sum + getDimsFn(it).w, 0);
      const gap = (lastRight - firstLeft - totalItemsWidth) / (sorted.length - 1);

      let currentLeft = firstLeft;
      sorted.forEach(item => {
        const d = getDimsFn(item);
        item.transform.x = currentLeft + d.w / 2;
        currentLeft += d.w + gap;
      });
    } else if (action === 'distribute-v' && items.length >= 3) {
      const sorted = [...items].sort((a, b) => (b.transform?.y || 0) - (a.transform?.y || 0));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const firstTop = (first.transform?.y || 0) + (getDimsFn(first).h / 2);
      const lastBottom = (last.transform?.y || 0) - (getDimsFn(last).h / 2);
      const totalItemsHeight = sorted.reduce((sum, it) => sum + getDimsFn(it).h, 0);
      const gap = (firstTop - lastBottom - totalItemsHeight) / (sorted.length - 1);

      let currentTop = firstTop;
      sorted.forEach(item => {
        const d = getDimsFn(item);
        item.transform.y = currentTop - d.h / 2;
        currentTop -= (d.h + gap);
      });
    }
  }

  /**
   * キャンバス上のクリック座標から最前面にある対象クリップを検出（幾何逆変換・ヒットテスト）
   * @param {Array<Object>} activeClips - 表示中のクリップ配列
   * @param {number} clickX - キャンバス中心基準のX座標
   * @param {number} clickY - キャンバス中心基準のY座標
   * @param {Function} getAnimTransformFn - クリップの現在変形座標取得関数
   * @param {Function} getDimsFn - クリップの未変形サイズ取得関数
   * @returns {Object|null} ヒットした最前面クリップ
   */
  hitTestClips(activeClips, clickX, clickY, getAnimTransformFn, getDimsFn) {
    // 最前面（V1優先）順にソート
    const sorted = [...activeClips].sort((a, b) => (a.trackIndex || 0) - (b.trackIndex || 0));

    return sorted.find(t => {
      const animT = getAnimTransformFn(t);
      const scale = Math.max(0.001, animT.scale || 1.0);
      const dx = clickX - (animT.x || 0);
      const dy = clickY - (animT.y || 0);

      let localX = dx;
      let localY = dy;

      // 2D回転の逆変換（数学座標系での逆回転変換）
      if (animT.rotation) {
        const rad = ((animT.rotation) * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        localX = (dx * cos - dy * sin);
        localY = (dx * sin + dy * cos);
      }
      localX /= scale;
      localY /= scale;

      // タッチしやすいよう +24px の安全タップマージンを追加
      const { w, h } = getDimsFn(t);
      const hitW = (w + 24) / 2;
      const hitH = (h + 24) / 2;

      return Math.abs(localX) <= hitW && Math.abs(localY) <= hitH;
    }) || null;
  }
}

window.KeyframeEngine = new KeyframeEngine();