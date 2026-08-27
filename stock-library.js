/**
 * StockLibrary - ストック素材（BGM・効果音・フレーム・ステッカー）管理
 */
class StockLibrary {
  constructor() {
    this._imageCache = new Map(); // 画像インスタンスキャッシュ
    this.svgTemplates = {
      // 1. YouTube & SNS・配信
      'svg-subscribe': {
        name: '登録ボタン (Subscribe)',
        defaultColor: '#ff0000',
        svg: (c) => `<svg viewBox="0 0 280 80" width="280" height="80" xmlns="http://www.w3.org/2000/svg"><rect width="280" height="80" rx="40" fill="${c}"/><path d="M50 25 L50 55 L75 40 Z" fill="#ffffff"/><text x="95" y="52" fill="#ffffff" font-size="28" font-weight="bold" font-family="sans-serif">SUBSCRIBE</text></svg>`
      },
      'svg-like': {
        name: 'いいね (Good手)',
        defaultColor: '#ff2d55',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3z"/></svg>`
      },
      'svg-dislike': {
        name: '低評価 (Bad手)',
        defaultColor: '#71717a',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3z"/></svg>`
      },
      'svg-bell': {
        name: '通知ベル (Remind)',
        defaultColor: '#ffcc00',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>`
      },
      'svg-share': {
        name: 'シェア・共有',
        defaultColor: '#00f0ff',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/></svg>`
      },
      'svg-live': {
        name: 'LIVE 配信中バッジ',
        defaultColor: '#ff2d55',
        svg: (c) => `<svg viewBox="0 0 180 70" width="180" height="70" xmlns="http://www.w3.org/2000/svg"><rect width="180" height="70" rx="16" fill="${c}"/><circle cx="35" cy="35" r="12" fill="#ffffff"/><text x="62" y="47" fill="#ffffff" font-size="32" font-weight="900" font-family="sans-serif">LIVE</text></svg>`
      },

      // 2. 感情 & エモート・リアクション
      'svg-heart': {
        name: 'ハート (Love)',
        defaultColor: '#ff0055',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`
      },
      'svg-fire': {
        name: '炎 (HOT/神回)',
        defaultColor: '#ff9500',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 23c-4.97 0-9-4.03-9-9 0-4.5 3.3-8.2 7.7-8.9.4-.1.7.3.5.7C10.5 7.6 11 9.5 12 10.5c.3.3.8.1.9-.3C13.6 7 15 4 14.5 1.5c-.1-.4.3-.8.7-.6 4.7 2.2 7.8 7 7.8 12.1 0 5.5-4.5 10-11 10z"/></svg>`
      },
      'svg-skull': {
        name: 'ドクロ (即死/激ムズ)',
        defaultColor: '#e4e4e7',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12c0 3.7 2.01 6.92 5 8.29V22h10v-1.71c2.99-1.37 5-4.59 5-8.29 0-5.52-4.48-10-10-10zm-3 13a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>`
      },
      'svg-sweat': {
        name: '汗マーク (焦り/ピンチ)',
        defaultColor: '#00f0ff',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>`
      },
      'svg-anger': {
        name: '怒りマーク (キレ)',
        defaultColor: '#ff2d55',
        svg: (c) => `<svg viewBox="0 0 100 100" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M20 20 L40 20 L40 5 L60 5 L60 20 L80 20 L80 40 L95 40 L95 60 L80 60 L80 80 L60 80 L60 95 L40 95 L40 80 L20 80 L20 60 L5 60 L5 40 L20 40 Z" opacity="0.95"/></svg>`
      },
      'svg-idea': {
        name: 'ひらめき電球 (解説)',
        defaultColor: '#ffeb3b',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>`
      },

      // 3. マンガ・演出・効果線
      'svg-speedlines': {
        name: 'マンガ集中線 (インパクト)',
        defaultColor: '#ffffff',
        svg: (c) => `<svg viewBox="0 0 200 200" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M100 0 L104 70 L96 70 Z M200 100 L130 104 L130 96 Z M100 200 L96 130 L104 130 Z M0 100 L70 96 L70 104 Z M170 30 L122 78 L128 84 Z M30 170 L78 122 L84 128 Z M170 170 L128 116 L122 122 Z M30 30 L84 72 L78 78 Z" opacity="0.85"/></svg>`
      },
      'svg-poof': {
        name: '爆発フキダシ (Shock)',
        defaultColor: '#ffeb3b',
        svg: (c) => `<svg viewBox="0 0 100 100" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M50 0 L60 25 L85 15 L75 40 L100 50 L75 60 L85 85 L60 75 L50 100 L40 75 L15 85 L25 60 L0 50 L25 40 L15 15 L40 25 Z"/></svg>`
      },
      'svg-sparkle': {
        name: 'キラキラ (光彩)',
        defaultColor: '#ffcc00',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 0L14.5 9.5L24 12L14.5 14.5L12 24L9.5 14.5L0 12L9.5 9.5L12 0z"/></svg>`
      },
      'svg-star4': {
        name: '四つ星クロス (きらめき)',
        defaultColor: '#00f0ff',
        svg: (c) => `<svg viewBox="0 0 100 100" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M50 0 Q50 50 100 50 Q50 50 50 100 Q50 50 0 50 Q50 50 50 0 Z"/></svg>`
      },
      'svg-popper': {
        name: 'クラッカー (祝/達成)',
        defaultColor: '#ff2d55',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M3 21l8.5-4.5L7 12 3 21zm10.5-8l-3-3 7-7 3 3-7 7zM18 2l2 2-2 2-2-2 2-2zM8 4l2 2-2 2-2-2 2-2zm12 8l2 2-2 2-2-2 2-2z"/></svg>`
      },
      'svg-dialog': {
        name: '角丸吹き出し',
        defaultColor: '#ffffff',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`
      },

      // 4. 指示 & 記号・カーソル
      'svg-point-hand': {
        name: '指差しアイコン',
        defaultColor: '#ffcc00',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74c1.21-.81 2-2.18 2-3.74a4.5 4.5 0 0 0-9 0c0 1.56.79 2.93 2 3.74zm9.84 4.63l-4.54-2.26A1.5 1.5 0 0 0 12 15h-.5v-7.5a1.5 1.5 0 0 0-3 0v10.63l-3.62-.76a1.5 1.5 0 0 0-1.44.43l-.44.44 5.3 5.3A3 3 0 0 0 10.42 24h6.88a3 3 0 0 0 2.92-2.31l1-5a1.5 1.5 0 0 0-.38-1.82z"/></svg>`
      },
      'svg-arrow': {
        name: '注目ネオン矢印',
        defaultColor: '#00f0ff',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>`
      },
      'svg-cursor': {
        name: 'マウスポインタ',
        defaultColor: '#ffffff',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M3 3l7 18 3-7 7-3L3 3z"/></svg>`
      },
      'svg-check': {
        name: 'チェック (正解/OK)',
        defaultColor: '#30d158',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`
      },
      'svg-cross': {
        name: 'バツ印 (不正解/NG)',
        defaultColor: '#ff2d55',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`
      },
      'svg-warning': {
        name: '警告マーク (注意)',
        defaultColor: '#ffcc00',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>`
      },
      'svg-question': {
        name: 'はてな (疑問/？)',
        defaultColor: '#00f0ff',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 16h-2v-2h2v2zm1.07-7.75l-.9.92C12.45 11.9 12 12.5 12 14h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H7c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.04-.42 1.99-1.07 2.75z"/></svg>`
      },

      'svg-crown': {
        name: '王冠 (1位/TOP)',
        defaultColor: '#ffcc00',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .55-.45 1-1 1H6c-.55 0-1-.45-1-1v-1h14v1z"/></svg>`
      },
      'svg-trophy': {
        name: 'トロフィー (優勝/王者)',
        defaultColor: '#ffcc00',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg">
          <!-- 単色・左右対称のクリーンなトロフィー -->
          <path d="M19 4h-3V2H8v2H5c-1.1 0-2 .9-2 2v2c0 2.5 1.9 4.6 4.4 4.9.7 1.8 2.2 3.1 4.1 3.5V19H8v2h8v-2h-3.5v-2.6c1.9-.4 3.4-1.7 4.1-3.5 2.5-.3 4.4-2.4 4.4-4.9V6c0-1.1-.9-2-2-2zM5 8V6h3v4.8C6.3 10.3 5 9.3 5 8zm14 0c0 1.3-1.3 2.3-3 2.8V6h3v2z"/>
        </svg>`
      },
      'svg-badge-star': {
        name: 'ゴールドスターバッジ',
        defaultColor: '#ffb703',
        svg: (c) => `<svg viewBox="0 0 24 24" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>`
      },
      'svg-leaf': {
        name: '初心者マーク (若葉)',
        defaultColor: '#30d158',
        svg: (c) => `<svg viewBox="0 0 100 120" width="256" height="256" fill="${c}" xmlns="http://www.w3.org/2000/svg">
          <!-- 隙間なし・一体型の単色若葉マーク（矢羽・矢じり形状） -->
          <path d="M50 32 L20 8 C10 1 2 10 2 22 L2 80 C2 100 32 116 50 120 C68 116 98 100 98 80 L98 22 C98 10 90 1 80 8 Z"/>
        </svg>`
      }
    };
  }

  createSvgImage(id, colorHex = '#00f0ff') {
    const item = this.svgTemplates[id] || this.svgTemplates['svg-like'];
    const cacheKey = `${id}_${colorHex}`;

    // キャッシュ済みの画像があれば再利用（メモリ消費ゼロ化）
    if (this._imageCache.has(cacheKey)) {
      return { img: this._imageCache.get(cacheKey), name: item.name, svgData: item.svg(colorHex) };
    }

    const svgStr = item.svg(colorHex);
    // Data URI 形式に変換（Blob URL 発行によるメモリリークを完全防止）
    const dataUri = 'data:image/svg+xml;utf8,' + encodeURIComponent(svgStr);
    const img = new Image();
    img.src = dataUri;

    this._imageCache.set(cacheKey, img);
    return { img, name: item.name, svgData: svgStr };
  }

  /**
   * タイムライン配置用の完全なステッカークリップオブジェクトを生成
   * @param {string} stickerId
   * @param {string} colorHex
   * @param {number} startTime
   * @param {number} duration
   * @returns {{ clip: Object, imageElement: HTMLImageElement }}
   */
  createStickerClip(stickerId, colorHex = '#00f0ff', startTime = 0, duration = 5) {
    const { img, name } = this.createSvgImage(stickerId, colorHex);
    const clip = {
      type: 'image',
      name: name,
      element: img,
      startTime: startTime,
      duration: duration,
      originalDuration: duration,
      physics: { enabled: false, bounciness: 0, isStatic: false },
      transform: { scale: 0.8, rotation: 0, rotateX: 0, rotateY: 0, x: 0, y: 0 }
    };
    return { clip, imageElement: img };
  }
}

window.StockLibrary = new StockLibrary();