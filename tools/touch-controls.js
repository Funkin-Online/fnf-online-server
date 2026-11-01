/**
 * Touch controller for the browser build (mobile.html).
 *
 * The engine's touch path only exists in native mobile compiles (`-Dmobile`
 * does not build for HTML5), so instead of recompiling we drive the game the
 * way a keyboard would: on-screen buttons dispatch the same key events Lime
 * listens for on `window`. Arrow keys are both menu navigation and the four
 * note lanes in this engine, so one D-pad plays and navigates.
 *
 * Injected into mobile.html by tools/build-docs.js; nothing here touches the
 * desktop page.
 */
(function () {
  'use strict';

  if (window.__fnfTouchLoaded) return;
  window.__fnfTouchLoaded = true;

  var CODE = {
    BACKSPACE: 8,
    ENTER: 13,
    ESCAPE: 27,
    SPACE: 32,
    LEFT: 37,
    UP: 38,
    RIGHT: 39,
    DOWN: 40,
    ZERO: 48
  };

  function dispatch(type, keyCode) {
    var event;
    try {
      event = new KeyboardEvent(type, { bubbles: true, cancelable: true });
    } catch (e) {
      return;
    }
    // Lime's HTML5 backend reads event.keyCode / charCode, which are read-only
    // on a real KeyboardEvent — define them on the instance instead.
    Object.defineProperty(event, 'keyCode', { get: function () { return keyCode; } });
    Object.defineProperty(event, 'which', { get: function () { return keyCode; } });
    Object.defineProperty(event, 'charCode', { get: function () { return type === 'keydown' ? keyCode : 0; } });
    window.dispatchEvent(event);
  }

  var style = document.createElement('style');
  style.textContent = [
    '.fnf-touch{position:fixed;inset:0;pointer-events:none;z-index:2147483000;',
    'font-family:"Trebuchet MS",system-ui,sans-serif;-webkit-user-select:none;user-select:none;',
    'padding:0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}',
    '.fnf-touch__pad{position:absolute;left:14px;bottom:16px;pointer-events:auto;display:grid;',
    'grid-template-columns:repeat(3,60px);grid-template-rows:repeat(3,60px);gap:6px}',
    '.fnf-touch__actions{position:absolute;right:14px;bottom:16px;pointer-events:auto;',
    'display:flex;align-items:flex-end;gap:10px}',
    '.fnf-touch__digits{position:absolute;right:14px;bottom:112px;pointer-events:auto;display:none;',
    'grid-template-columns:repeat(3,56px);grid-auto-rows:52px;gap:6px}',
    '.fnf-touch__digits.is-open{display:grid}',
    '.fnf-touch button{border:2px solid rgba(244,244,248,.35);border-radius:14px;',
    'background:rgba(24,24,32,.62);color:#f4f4f8;font:inherit;font-size:20px;font-weight:700;',
    'letter-spacing:.04em;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);',
    'touch-action:none;padding:0;margin:0;display:flex;align-items:center;justify-content:center}',
    '.fnf-touch button:active,.fnf-touch button.is-held{background:rgba(255,61,127,.75);border-color:#ffd93d}',
    '.fnf-touch__pad button{width:60px;height:60px;font-size:24px}',
    '.fnf-touch__round{width:74px;height:74px;border-radius:50%;font-size:26px}',
    '.fnf-touch__round--a{border-color:rgba(91,227,125,.85)}',
    '.fnf-touch__round--b{border-color:rgba(255,61,127,.85)}',
    '.fnf-touch__small{width:56px;height:44px;font-size:13px;letter-spacing:.1em}',
    '.fnf-touch__menu{position:absolute;top:max(10px,env(safe-area-inset-top));right:12px;',
    'pointer-events:auto;display:flex;gap:8px}',
    '.fnf-touch__hidden .fnf-touch__pad,.fnf-touch__hidden .fnf-touch__actions,',
    '.fnf-touch__hidden .fnf-touch__digits{display:none!important}',
    '@media (max-height:430px){.fnf-touch__pad{grid-template-columns:repeat(3,48px);',
    'grid-template-rows:repeat(3,48px)}.fnf-touch__pad button{width:48px;height:48px;font-size:20px}',
    '.fnf-touch__round{width:60px;height:60px}}'
  ].join('');
  document.head.appendChild(style);

  var root = document.createElement('div');
  root.className = 'fnf-touch';

  function button(label, keyCode, className, extra) {
    var element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.className = className || '';
    if (extra) element.setAttribute('aria-label', extra);
    if (typeof keyCode === 'number') {
      bind(element, keyCode);
    }
    return element;
  }

  function bind(element, keyCode) {
    function down(event) {
      event.preventDefault();
      element.classList.add('is-held');
      dispatch('keydown', keyCode);
    }
    function up(event) {
      if (event) event.preventDefault();
      if (!element.classList.contains('is-held')) return;
      element.classList.remove('is-held');
      dispatch('keyup', keyCode);
    }
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('pointerleave', up);
    element.addEventListener('contextmenu', function (event) { event.preventDefault(); });
  }

  // D-pad: menu movement, and the four note lanes during a song.
  var pad = document.createElement('div');
  pad.className = 'fnf-touch__pad';
  pad.appendChild(document.createElement('span'));
  pad.appendChild(button('▲', CODE.UP, '', 'Up'));
  pad.appendChild(document.createElement('span'));
  pad.appendChild(button('◀', CODE.LEFT, '', 'Left'));
  pad.appendChild(document.createElement('span'));
  pad.appendChild(button('▶', CODE.RIGHT, '', 'Right'));
  pad.appendChild(document.createElement('span'));
  pad.appendChild(button('▼', CODE.DOWN, '', 'Down'));
  pad.appendChild(document.createElement('span'));
  root.appendChild(pad);

  // Confirm / back / space.
  var actions = document.createElement('div');
  actions.className = 'fnf-touch__actions';
  var spaceButton = button('SPACE', CODE.SPACE, 'fnf-touch__small', 'Space');
  var backButton = button('B', CODE.ESCAPE, 'fnf-touch__round fnf-touch__round--b', 'Back');
  var okButton = button('A', CODE.ENTER, 'fnf-touch__round fnf-touch__round--a', 'Confirm');
  actions.appendChild(spaceButton);
  actions.appendChild(backButton);
  actions.appendChild(okButton);
  root.appendChild(actions);

  // Number pad, for lobby codes and any typed field.
  var digits = document.createElement('div');
  digits.className = 'fnf-touch__digits';
  for (var d = 1; d <= 9; d++) {
    digits.appendChild(button(String(d), CODE.ZERO + d, '', 'Digit ' + d));
  }
  digits.appendChild(button('⌫', CODE.BACKSPACE, '', 'Backspace'));
  digits.appendChild(button('0', CODE.ZERO, '', 'Digit 0'));
  var closeDigits = button('✕', null, '', 'Close keypad');
  closeDigits.addEventListener('click', function () { digits.classList.remove('is-open'); });
  digits.appendChild(closeDigits);
  root.appendChild(digits);

  // Top-right: keypad toggle and a hide switch, so the pad never traps anyone.
  var menu = document.createElement('div');
  menu.className = 'fnf-touch__menu';
  var padToggle = button('123', null, 'fnf-touch__small', 'Show numbers');
  padToggle.addEventListener('click', function () { digits.classList.toggle('is-open'); });
  var hideToggle = button('⤢', null, 'fnf-touch__small', 'Hide or show the controls');
  hideToggle.addEventListener('click', function () { root.classList.toggle('fnf-touch__hidden'); });
  menu.appendChild(padToggle);
  menu.appendChild(hideToggle);
  root.appendChild(menu);

  function mount() {
    (document.body || document.documentElement).appendChild(root);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  // The game canvas should not scroll or zoom under a thumb.
  document.addEventListener('gesturestart', function (event) { event.preventDefault(); });
})();
