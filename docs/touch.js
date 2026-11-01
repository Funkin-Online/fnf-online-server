/**
 * Touch controller for the browser build (mobile.html).
 *
 * The engine's touch path only exists in native mobile compiles (`-Dmobile`
 * does not build for HTML5), so instead of recompiling we drive the game the
 * way a keyboard would: on-screen buttons dispatch the same key events Lime
 * listens for on `window`. Arrow keys are both menu navigation and the four
 * note lanes in this engine, so the arrows play and navigate.
 *
 * ARRANGE MODE — the "✥" button lets the player drag EACH arrow on its own, plus
 * the action buttons and the number pad, anywhere on screen. Every control
 * remembers its own spot, so one thumb can sit high and the other low. Positions
 * are saved per device (localStorage) and clamped to the viewport, including
 * after a rotation. "Reset" puts everything back in the default cross.
 *
 * Injected into mobile.html by tools/build-docs.js; nothing here touches the
 * desktop page.
 */
(function () {
  'use strict';

  if (window.__fnfTouchLoaded) return;
  window.__fnfTouchLoaded = true;

  var STORAGE_KEY = 'fnfTouch.layout.v2';

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

  var ARROWS = [
    { key: 'up', label: '▲', code: CODE.UP, modifier: 'up', title: 'Up' },
    { key: 'left', label: '◀', code: CODE.LEFT, modifier: 'left', title: 'Left' },
    { key: 'right', label: '▶', code: CODE.RIGHT, modifier: 'right', title: 'Right' },
    { key: 'down', label: '▼', code: CODE.DOWN, modifier: 'down', title: 'Down' }
  ];

  var arranging = false;
  var groups = {};

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

  // ---- saved layout ------------------------------------------------------

  function loadLayout() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function saveLayout(layout) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch (e) {}
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function place(element, position) {
    if (!element || !position) return;
    var width = element.offsetWidth || 60;
    var height = element.offsetHeight || 60;
    var x = clamp(Number(position.x) || 0, 0, Math.max(0, window.innerWidth - width));
    var y = clamp(Number(position.y) || 0, 0, Math.max(0, window.innerHeight - height));
    element.style.left = x + 'px';
    element.style.top = y + 'px';
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  }

  function positionOf(element) {
    var rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left), y: Math.round(rect.top) };
  }

  function storeGroup(key, element) {
    groups[key] = element;
    var saved = loadLayout()[key];
    if (saved) place(element, saved);
  }

  function persistGroup(key) {
    var element = groups[key];
    if (!element) return;
    var layout = loadLayout();
    layout[key] = positionOf(element);
    saveLayout(layout);
  }

  function resetLayout() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      // Older builds saved the arrows as one block; drop that too.
      window.localStorage.removeItem('fnfTouch.layout.v1');
    } catch (e) {}
    for (var key in groups) {
      var element = groups[key];
      if (!element) continue;
      element.style.left = '';
      element.style.top = '';
      element.style.right = '';
      element.style.bottom = '';
    }
  }

  // ---- dragging ----------------------------------------------------------

  function makeDraggable(key, element) {
    element.addEventListener('pointerdown', function (event) {
      if (!arranging) return;
      event.preventDefault();
      event.stopPropagation();

      var rect = element.getBoundingClientRect();
      var offsetX = event.clientX - rect.left;
      var offsetY = event.clientY - rect.top;
      try {
        element.setPointerCapture(event.pointerId);
      } catch (e) {}

      function move(moveEvent) {
        moveEvent.preventDefault();
        place(element, { x: moveEvent.clientX - offsetX, y: moveEvent.clientY - offsetY });
      }

      function finish(endEvent) {
        if (endEvent) endEvent.preventDefault();
        element.removeEventListener('pointermove', move);
        element.removeEventListener('pointerup', finish);
        element.removeEventListener('pointercancel', finish);
        persistGroup(key);
      }

      element.addEventListener('pointermove', move);
      element.addEventListener('pointerup', finish);
      element.addEventListener('pointercancel', finish);
    });
  }

  // ---- styles ------------------------------------------------------------

  var style = document.createElement('style');
  style.textContent = [
    '.fnf-touch{position:fixed;inset:0;pointer-events:none;z-index:2147483000;',
    'font-family:"Trebuchet MS",system-ui,sans-serif;-webkit-user-select:none;user-select:none;',
    'padding:0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}',
    // each arrow is its own control, defaulted to the classic cross
    '.fnf-touch__arrow{position:absolute;width:60px;height:60px;font-size:24px;pointer-events:auto}',
    '.fnf-touch__arrow--up{left:80px;bottom:148px}',
    '.fnf-touch__arrow--left{left:14px;bottom:82px}',
    '.fnf-touch__arrow--right{left:146px;bottom:82px}',
    '.fnf-touch__arrow--down{left:80px;bottom:16px}',
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
    '.fnf-touch__round{width:74px;height:74px;border-radius:50%;font-size:26px}',
    '.fnf-touch__round--a{border-color:rgba(91,227,125,.85)}',
    '.fnf-touch__round--b{border-color:rgba(255,61,127,.85)}',
    '.fnf-touch__small{width:56px;height:44px;font-size:13px;letter-spacing:.1em}',
    '.fnf-touch__menu{position:absolute;top:max(10px,env(safe-area-inset-top));right:12px;',
    'pointer-events:auto;display:flex;gap:8px}',
    '.fnf-touch__hidden .fnf-touch__arrow,.fnf-touch__hidden .fnf-touch__actions,',
    '.fnf-touch__hidden .fnf-touch__digits{display:none!important}',
    // arrange mode: arrows stay tappable so they can be grabbed
    '.fnf-touch--arrange .fnf-touch__arrow,.fnf-touch--arrange .fnf-touch__actions,',
    '.fnf-touch--arrange .fnf-touch__digits{outline:2px dashed rgba(255,217,61,.9);outline-offset:8px;',
    'cursor:grab;touch-action:none}',
    '.fnf-touch--arrange .fnf-touch__actions button,',
    '.fnf-touch--arrange .fnf-touch__digits button{pointer-events:none;opacity:.9}',
    '.fnf-touch__bar{position:absolute;left:50%;transform:translateX(-50%);',
    'top:max(10px,env(safe-area-inset-top));pointer-events:auto;display:none;align-items:center;gap:8px;',
    'padding:8px 10px;border-radius:14px;background:rgba(16,16,20,.92);border:2px solid rgba(255,217,61,.8);',
    'color:#f4f4f8;font-size:12px;letter-spacing:.06em;max-width:94vw}',
    '.fnf-touch--arrange .fnf-touch__bar{display:flex}',
    '.fnf-touch__bar span{line-height:1.35}',
    '.fnf-touch__bar button{width:auto;padding:0 12px;height:40px;font-size:13px}',
    '@media (max-height:430px){.fnf-touch__round{width:60px;height:60px}}'
  ].join('');
  document.head.appendChild(style);

  // ---- controls ----------------------------------------------------------

  var root = document.createElement('div');
  root.className = 'fnf-touch';

  function button(label, keyCode, className, extra) {
    var element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.className = className || '';
    if (extra) element.setAttribute('aria-label', extra);
    if (typeof keyCode === 'number') bind(element, keyCode);
    return element;
  }

  function bind(element, keyCode) {
    function down(event) {
      if (arranging) return;
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

  // Four separate arrows: each one drags and stores its own position.
  var arrowElements = {};
  for (var a = 0; a < ARROWS.length; a++) {
    var spec = ARROWS[a];
    var arrow = button(spec.label, spec.code, 'fnf-touch__arrow fnf-touch__arrow--' + spec.modifier, spec.title);
    arrow.setAttribute('data-arrow', spec.key);
    root.appendChild(arrow);
    arrowElements[spec.key] = arrow;
  }

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

  // Arrange bar: drag hint, Done, Reset.
  var bar = document.createElement('div');
  bar.className = 'fnf-touch__bar';
  var barText = document.createElement('span');
  barText.textContent = 'Drag any arrow, the buttons or the keypad — each one moves on its own.';
  var resetButton = button('Reset', null, '', 'Reset control positions');
  resetButton.addEventListener('click', function () { resetLayout(); });
  var doneButton = button('Done', null, '', 'Finish arranging');
  doneButton.addEventListener('click', function () { setArranging(false); });
  bar.appendChild(barText);
  bar.appendChild(resetButton);
  bar.appendChild(doneButton);
  root.appendChild(bar);

  // Top-right: keypad toggle, arrange, hide.
  var menu = document.createElement('div');
  menu.className = 'fnf-touch__menu';
  var padToggle = button('123', null, 'fnf-touch__small', 'Show numbers');
  padToggle.addEventListener('click', function () { digits.classList.toggle('is-open'); });
  var arrangeToggle = button('✥', null, 'fnf-touch__small', 'Move the controls');
  arrangeToggle.addEventListener('click', function () { setArranging(!arranging); });
  var hideToggle = button('⤢', null, 'fnf-touch__small', 'Hide or show the controls');
  hideToggle.addEventListener('click', function () { root.classList.toggle('fnf-touch__hidden'); });
  menu.appendChild(padToggle);
  menu.appendChild(arrangeToggle);
  menu.appendChild(hideToggle);
  root.appendChild(menu);

  function setArranging(next) {
    arranging = next;
    root.classList.toggle('fnf-touch--arrange', arranging);
    arrangeToggle.classList.toggle('is-held', arranging);
    if (arranging) {
      digits.classList.add('is-open');
      root.classList.remove('fnf-touch__hidden');
    } else {
      for (var key in groups) persistGroup(key);
    }
  }

  function layout() {
    for (var key in arrowElements) {
      storeGroup(key, arrowElements[key]);
      makeDraggable(key, arrowElements[key]);
    }
    storeGroup('actions', actions);
    makeDraggable('actions', actions);
    storeGroup('digits', digits);
    makeDraggable('digits', digits);
  }

  function mount() {
    (document.body || document.documentElement).appendChild(root);
    layout();
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  // Keep saved controls on screen when the phone rotates or the window resizes.
  window.addEventListener('resize', function () {
    var saved = loadLayout();
    for (var key in groups) {
      if (groups[key] && saved[key]) place(groups[key], saved[key]);
    }
  });

  // The game canvas should not scroll or zoom under a thumb.
  document.addEventListener('gesturestart', function (event) { event.preventDefault(); });
})();
