import * as THREE from 'three';

export interface SpatialSourceOptions {
  /** 音频地址（相对站点根路径或绝对 URL）。 */
  url: string;
  /** 音源在场景中的位置。 */
  position: THREE.Vector3 | [number, number, number];
  /** 音量 0~1。 */
  volume?: number;
  /** 是否循环（默认循环）。 */
  loop?: boolean;
  /** 声源开始衰减的距离（米）。 */
  refDistance?: number;
  /** 最远可听距离（米）。 */
  maxDistance?: number;
}

/**
 * 在场景中的某个位置放置一个**空间音源**。
 *
 * three 的 `PositionalAudio` 会用原生 `PannerNode` 定位声源，
 * 配合跟随相机的 `AudioListener`（见 `Stage.listener`），
 * 用户在 VR 里转头时，环境声会从对应方向传来 —— 这是头显里最直接的感知升级。
 *
 * @returns 音源对象；场景销毁时调用 `sound.stop()` 并从 root 移除即可。
 */
export function attachSpatialSource(
  root: THREE.Object3D,
  listener: THREE.AudioListener,
  options: SpatialSourceOptions
): THREE.PositionalAudio {
  const sound = new THREE.PositionalAudio(listener);

  const position = Array.isArray(options.position)
    ? new THREE.Vector3(options.position[0], options.position[1], options.position[2])
    : options.position.clone();
  sound.position.copy(position);

  sound.setRefDistance(options.refDistance ?? 2.5);
  sound.setMaxDistance(options.maxDistance ?? 60);
  sound.setLoop(options.loop ?? true);
  sound.setVolume(options.volume ?? 0.5);
  sound.setDistanceModel('exponential');

  root.add(sound);

  // three r186 的 Audio 没有 load()，需要自己取流并解码后 setBuffer
  void loadAudioBuffer(listener.context, options.url)
    .then((buffer) => {
      sound.setBuffer(buffer);
      return sound.play();
    })
    .catch((error) => {
      console.warn('[spatial-audio] 空间音源播放失败（可能需要用户手势）', error);
    });

  return sound;
}

/** 抓取并解码音频。 */
async function loadAudioBuffer(context: BaseAudioContext, url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`空间音源加载失败：${url} (${response.status})`);
  const bytes = await response.arrayBuffer();
  return context.decodeAudioData(bytes);
}
