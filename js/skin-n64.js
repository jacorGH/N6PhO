// Controller skin, as data. Units: portrait 1u = 1% of screen width; landscape 1u = 1% of screen height.
// anchor: first letter t/b (measure y from top or bottom), second l/c/r (measure x from left, centre or right).
// types: button (inputs[]), stick, dpad / cpad (inputs {up,down,left,right}), menu.
window.N6_SKINS = window.N6_SKINS || {};
window.N6_SKINS.n64 = {
  name: 'N6PhO Classic',
  portrait: {
    minH: 84,   // skin height (in u) needed before it starts shrinking
    lift: 0.35, // on tall phones, raise the controls by this share of the spare space
    items: [
      { type: 'button', id: 'L', inputs: ['L'], label: 'L', anchor: 'bl', x: 3, y: 71, w: 20, h: 9, shape: 'shoulder' },
      { type: 'menu', id: 'menu', anchor: 'bc', x: 0, y: 71, w: 10, h: 9 },
      { type: 'button', id: 'Z', inputs: ['Z'], label: 'Z', anchor: 'br', x: 24, y: 71, w: 20, h: 9, shape: 'shoulder' },
      { type: 'button', id: 'R', inputs: ['R'], label: 'R', anchor: 'br', x: 3, y: 71, w: 20, h: 9, shape: 'shoulder' },

      { type: 'stick', id: 'stick', anchor: 'bl', x: 4, y: 28, w: 38, h: 38 },
      { type: 'dpad', id: 'dpad', inputs: { up: 'DUP', down: 'DDOWN', left: 'DLEFT', right: 'DRIGHT' }, anchor: 'bl', x: 9, y: 3, w: 22, h: 22 },
      { type: 'button', id: 'START', inputs: ['START'], label: 'Start', anchor: 'bc', x: 0, y: 4, w: 15, h: 7, shape: 'pill', color: 'start' },

      { type: 'cpad', id: 'cpad', inputs: { up: 'CUP', down: 'CDOWN', left: 'CLEFT', right: 'CRIGHT' }, anchor: 'br', x: 3, y: 32, w: 32, h: 32 },
      { type: 'button', id: 'A', inputs: ['A'], label: 'A', anchor: 'br', x: 16, y: 4, w: 20, h: 20, shape: 'round', color: 'a' },
      { type: 'button', id: 'B', inputs: ['B'], label: 'B', anchor: 'br', x: 36, y: 15, w: 16, h: 16, shape: 'round', color: 'b' }
    ]
  },
  landscape: {
    items: [
      { type: 'button', id: 'L', inputs: ['L'], label: 'L', anchor: 'tl', x: 3, y: 4, w: 17, h: 11, shape: 'shoulder' },
      { type: 'menu', id: 'menu', anchor: 'tc', x: 0, y: 3, w: 9, h: 10 },
      { type: 'button', id: 'R', inputs: ['R'], label: 'R', anchor: 'tr', x: 3, y: 4, w: 17, h: 11, shape: 'shoulder' },
      { type: 'button', id: 'Z', inputs: ['Z'], label: 'Z', anchor: 'tr', x: 3, y: 18, w: 17, h: 11, shape: 'shoulder' },

      { type: 'stick', id: 'stick', anchor: 'bl', x: 5, y: 33, w: 34, h: 34 },
      { type: 'dpad', id: 'dpad', inputs: { up: 'DUP', down: 'DDOWN', left: 'DLEFT', right: 'DRIGHT' }, anchor: 'bl', x: 8, y: 4, w: 25, h: 25 },
      { type: 'button', id: 'START', inputs: ['START'], label: 'Start', anchor: 'bc', x: 0, y: 3, w: 13, h: 8, shape: 'pill', color: 'start' },

      { type: 'cpad', id: 'cpad', inputs: { up: 'CUP', down: 'CDOWN', left: 'CLEFT', right: 'CRIGHT' }, anchor: 'br', x: 3, y: 34, w: 30, h: 30 },
      { type: 'button', id: 'A', inputs: ['A'], label: 'A', anchor: 'br', x: 14, y: 5, w: 20, h: 20, shape: 'round', color: 'a' },
      { type: 'button', id: 'B', inputs: ['B'], label: 'B', anchor: 'br', x: 35, y: 16, w: 16, h: 16, shape: 'round', color: 'b' }
    ]
  }
};
