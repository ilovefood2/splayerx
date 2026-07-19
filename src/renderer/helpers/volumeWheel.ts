type VolumeWheelEvent = {
  ctrlKey: boolean,
  deltaX: number,
  deltaY: number,
};

type VolumeWheelOptions = {
  platform: string,
  reverseScrolling: boolean,
};

export type VolumeWheelAdjustment = {
  increase: boolean,
  step: number,
};

export function getVolumeWheelAdjustment(
  event: VolumeWheelEvent,
  options: VolumeWheelOptions,
): VolumeWheelAdjustment | null {
  const { ctrlKey, deltaX, deltaY } = event;
  if (ctrlKey || !deltaY || Math.abs(deltaX) >= Math.abs(deltaY)) return null;

  let step = Math.abs(deltaY) * 0.06;
  if (options.platform !== 'darwin') step = Math.min(step, 6);

  const followsNaturalScrolling = options.platform === 'darwin'
    ? !options.reverseScrolling
    : options.reverseScrolling;

  return {
    increase: followsNaturalScrolling ? deltaY > 0 : deltaY < 0,
    step,
  };
}
