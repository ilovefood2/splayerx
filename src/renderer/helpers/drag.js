import { ipcRenderer, remote } from 'electron'; //eslint-disable-line

function getRatio() {
  return window.devicePixelRatio || 1;
}

function parentsHasClass(element, className) {
  if (!element || !element.classList) { return false; }
  if (element.classList.contains(className)) { return true; }
  return parentsHasClass(element.parentNode, className);
}

function registerDarwinDrag(element) {
  let dragOrigin = null;

  const stopDragging = () => {
    dragOrigin = null;
  };

  const onmousedown = (event) => {
    if (event.button !== 0 || parentsHasClass(event.target, 'no-drag')) return;
    const currentWindow = remote.getCurrentWindow();
    if (!currentWindow || currentWindow.isFullScreen()) return;
    dragOrigin = {
      pointer: [event.screenX, event.screenY],
      window: currentWindow.getPosition(),
    };
  };

  const onmousemove = (event) => {
    if (!dragOrigin) return;
    if (!(event.buttons & 1)) {
      stopDragging();
      return;
    }
    const x = Math.round(dragOrigin.window[0] + event.screenX - dragOrigin.pointer[0]);
    const y = Math.round(dragOrigin.window[1] + event.screenY - dragOrigin.pointer[1]);
    ipcRenderer.send('setFocusedWindowPosition', [x, y]);
  };

  element.addEventListener('mousedown', onmousedown, false);
  window.addEventListener('mousemove', onmousemove, true);
  window.addEventListener('mouseup', stopDragging, true);
  window.addEventListener('blur', stopDragging);

  return () => {
    element.removeEventListener('mousedown', onmousedown);
    window.removeEventListener('mousemove', onmousemove, true);
    window.removeEventListener('mouseup', stopDragging, true);
    window.removeEventListener('blur', stopDragging);
  };
}

function registerWindowsDrag(element) {
  let offset = null;
  const onmousedown = (e) => {
    // In WebKit、Gecko which property in MouseEvent can judge if right click
    // In IE can use button property in MouseEvent
    // 当在windows系统下面，右键窗口会打开目录，同时也会执行mousedown
    // 在mousedown内部判断e.which是否为rightClick，来过滤这些事件
    if (e && e.which === 3) return;
    if (parentsHasClass(e.target, 'no-drag')) {
      offset = null;
    } else {
      offset = [e.clientX, e.clientY];
    }
  };

  element.addEventListener('mousedown', onmousedown, false);

  // 在windows系统下，正常情况win-mouse模块的left-up事件会正常触发，但是虚拟机下面
  // 有时会失效，导致拖动窗口，松开鼠标，应用窗口吸附的bug，通过mouseup，来释放拖拽
  const onmouseup = () => {
    offset = null;
  };
  element.addEventListener('mouseup', onmouseup, true);

  ipcRenderer.on('mouse-left-drag', (evt, x, y) => {
    if (!offset) return;
    x = Math.round((x / getRatio()) - offset[0]);
    y = Math.round((y / getRatio()) - offset[1]);
    ipcRenderer.send('setFocusedWindowPosition', [x, y]);
  });

  ipcRenderer.on('mouse-left-up', () => {
    offset = null;
  });

  return () => {
    element.removeEventListener('mousedown', onmousedown);
    element.removeEventListener('mouseup', onmouseup);
  };
}

export default function drag(element, platform = process.platform) {
  if (platform === 'darwin') return registerDarwinDrag(element);
  if (platform === 'win32') return registerWindowsDrag(element);
  return () => {};
}
